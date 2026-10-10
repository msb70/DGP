-- DGP · Migración 10c (revisión de Hermes, 10-oct-2026). Idempotente: se puede ejecutar más de una vez.
-- Pegar completo en Supabase → SQL Editor → Run. Requiere 10b ya aplicada. Equivale a la sección 10c de v3_produccion.sql
-- más la corrección del trigger guardia_conductor (fallaba en pedido_lineas: entrega parcial del conductor).
-- ¿La sentencia la hace un usuario de la app (PostgREST con rol authenticated/anon)? El servidor (service_role) y el SQL
-- Editor no pasan por los controles de columnas. Se mira el rol activo y no solo auth.uid(), que puede quedar en la sesión.
create or replace function dgp_private.es_usuario_app() returns boolean language sql stable set search_path = public, pg_temp as $$
  select auth.uid() is not null and coalesce(current_setting('role', true), 'none') in ('authenticated', 'anon') $$;
create or replace function dgp_private.guardia_conductor() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare libres text[] := string_to_array(TG_ARGV[0], ','); trans text[] := string_to_array(coalesce(TG_ARGV[1], ''), ',');
begin
  if not dgp_private.es_usuario_app() or dgp_private.escribe(TG_TABLE_NAME) then return new; end if;
  if (to_jsonb(new) - libres) is distinct from (to_jsonb(old) - libres) then
    raise exception 'El conductor no puede modificar esos datos de %', TG_TABLE_NAME using errcode = '42501';
  end if;
  -- estado vía jsonb: PL/pgSQL resuelve new.estado aunque la tabla no lo tenga (pedido_lineas) y fallaría
  if 'estado' = any(libres) and (to_jsonb(new)->>'estado') is distinct from (to_jsonb(old)->>'estado')
     and not ((to_jsonb(old)->>'estado') || '>' || (to_jsonb(new)->>'estado')) = any(trans) then
    raise exception 'Cambio de estado no permitido para el conductor en %: % → %', TG_TABLE_NAME, to_jsonb(old)->>'estado', to_jsonb(new)->>'estado' using errcode = '42501';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 10c. Correcciones de la revisión de Hermes (10-oct-2026)
-- ---------------------------------------------------------------------
-- LOGIC-002: conciliación de costos atómica, solo de rutas CERRADAS y con datos reales (sin fabricar km, consumo ni peajes).
--   Si faltan datos la ruta queda "cerrada" con costos_ruta.datos_completos = false y la lista de faltantes; no se marca conciliada.
alter table costos_ruta add column if not exists datos_completos boolean default false;
alter table costos_ruta add column if not exists faltantes text[];
create or replace function public.conciliar_ruta(rid uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r rutas; v vehiculos; cfg jsonb; km numeric; lit numeric; c_comb numeric; c_pe numeric; n_ab int; ent int;
        l_esp numeric; desv numeric; c_mo numeric; c_ma numeric; tot numeric; falt text[] := '{}';
begin
  if dgp_private.es_usuario_app() and not dgp_private.tiene('costos.gestionar') then
    raise exception 'Tu rol no puede conciliar costos' using errcode = '42501';
  end if;
  select * into r from rutas where id = rid for update;
  if not found then raise exception 'Ruta no encontrada' using errcode = 'P0002'; end if;
  if r.estado = 'conciliada' then return jsonb_build_object('ruta', r.codigo, 'ya', true, 'conciliada', true); end if;
  if r.estado <> 'cerrada' then
    raise exception 'Solo se concilian rutas cerradas: % está en %', r.codigo, r.estado using errcode = '22023';
  end if;
  select * into v from vehiculos where id = r.vehiculo_id;
  select coalesce((select valor from reglas where clave = 'costos_ruta'), '{}'::jsonb) into cfg;
  if r.odometro_salida is null or r.odometro_llegada is null then falt := array_append(falt, 'odómetros de salida y llegada'); end if;
  km := case when r.odometro_salida is not null and r.odometro_llegada is not null then r.odometro_llegada - r.odometro_salida end;
  select count(*), coalesce(sum(litros), 0), coalesce(sum(costo), 0) into n_ab, lit, c_comb from abastecimientos where ruta_id = rid;
  if n_ab = 0 then falt := array_append(falt, 'abastecimientos de combustible (litros y costo)'); end if;
  select coalesce(sum(monto_real), 0) into c_pe from peajes where ruta_id = rid;   -- solo peajes registrados/importados; no se inventan
  select count(*) into ent from paradas where ruta_id = rid and tipo = 'entrega';
  l_esp := case when km is not null and coalesce(v.km_por_litro, 0) > 0 then km / v.km_por_litro end;
  desv := case when l_esp > 0 and n_ab > 0 then (lit / l_esp - 1) * 100 end;
  -- parámetros de costo (no son mediciones): reglas.costos_ruta = {mano_obra_con_ayudante, mano_obra_sin_ayudante, mantenimiento_por_km}
  c_mo := case when r.ayudante is not null and r.ayudante <> '' then coalesce((cfg->>'mano_obra_con_ayudante')::numeric, 150) else coalesce((cfg->>'mano_obra_sin_ayudante')::numeric, 85) end;
  c_ma := coalesce(km, 0) * coalesce((cfg->>'mantenimiento_por_km')::numeric, 0.09);
  tot := case when cardinality(falt) = 0 then c_comb + c_pe + c_mo + c_ma end;
  insert into costos_ruta (ruta_id, km_plan, km_real, litros_esperados, litros_reales, desviacion_pct, costo_combustible, costo_peajes,
                           costo_mano_obra, costo_mantenimiento, costo_total, valor_vendido, entregas, costo_por_entrega, costo_por_km,
                           pct_sobre_venta, calculado_at, datos_completos, faltantes)
  values (rid, r.km_plan, km, round(l_esp, 2), case when n_ab > 0 then lit end, round(desv, 1), case when n_ab > 0 then c_comb end, c_pe,
          c_mo, round(c_ma, 2), round(tot, 2), r.valor, ent, round(tot / greatest(ent, 1), 2), round(tot / greatest(km, 1), 3),
          round(tot / greatest(coalesce(r.valor, 0), 1) * 100, 2), now(), cardinality(falt) = 0, falt)
  on conflict (ruta_id) do update set km_plan = excluded.km_plan, km_real = excluded.km_real, litros_esperados = excluded.litros_esperados,
    litros_reales = excluded.litros_reales, desviacion_pct = excluded.desviacion_pct, costo_combustible = excluded.costo_combustible,
    costo_peajes = excluded.costo_peajes, costo_mano_obra = excluded.costo_mano_obra, costo_mantenimiento = excluded.costo_mantenimiento,
    costo_total = excluded.costo_total, valor_vendido = excluded.valor_vendido, entregas = excluded.entregas,
    costo_por_entrega = excluded.costo_por_entrega, costo_por_km = excluded.costo_por_km, pct_sobre_venta = excluded.pct_sobre_venta,
    calculado_at = excluded.calculado_at, datos_completos = excluded.datos_completos, faltantes = excluded.faltantes;
  if cardinality(falt) = 0 then update rutas set estado = 'conciliada', km_real = km where id = rid; end if;
  return jsonb_build_object('ruta', r.codigo, 'conciliada', cardinality(falt) = 0, 'faltantes', to_jsonb(falt),
                            'desviacion_pct', round(desv, 1), 'placa', v.placa, 'costo_total', round(tot, 2));
end $$;
revoke execute on function public.conciliar_ruta(uuid) from public, anon;
grant execute on function public.conciliar_ruta(uuid) to authenticated, service_role;

-- DATA-001: una entrega (parada + pedido + líneas) se guarda entera o no se guarda. Corre con los permisos de quien llama
--   (RLS y guardia del conductor aplican); si cualquier paso no afecta exactamente a su fila, se revierte todo. Repetirla con
--   los mismos datos (cola sin señal) no cambia nada.
create or replace function public.registrar_entrega(parada uuid, resultado text, datos jsonb, lineas jsonb default '[]'::jsonb) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare s paradas; est_p text; est_ped text; l jsonb; n int;
begin
  select * into s from paradas where id = parada;
  if not found then raise exception 'Parada no encontrada o fuera de tus rutas' using errcode = '42501'; end if;
  est_p := case resultado when 'total' then 'atendida' when 'parcial' then 'parcial' when 'no' then 'no_entregada' end;
  est_ped := case resultado when 'total' then 'entregado' when 'parcial' then 'parcial' when 'no' then 'no_entregado' end;
  if est_p is null then raise exception 'Resultado de entrega inválido: %', resultado using errcode = '22023'; end if;
  if resultado = 'parcial' then
    if jsonb_typeof(lineas) <> 'array' or jsonb_array_length(lineas) = 0 then raise exception 'La entrega parcial necesita las cantidades entregadas' using errcode = '22023'; end if;
    for l in select * from jsonb_array_elements(lineas) loop
      update pedido_lineas set entregado = (l->>'entregado')::int where id = (l->>'id')::uuid and pedido_id = s.pedido_id;
      get diagnostics n = row_count;
      if n <> 1 then raise exception 'La línea % no pertenece a este pedido o no tienes acceso', l->>'id' using errcode = '42501'; end if;
    end loop;
  end if;
  update paradas set estado = est_p, checkout_at = coalesce((datos->>'checkout_at')::timestamptz, now()), resultado = datos->>'resultado',
         receptor = datos->>'receptor', firma = datos->>'firma', foto = datos->>'foto', fotos = datos->'fotos'
   where id = parada;
  get diagnostics n = row_count; if n <> 1 then raise exception 'No se pudo actualizar la parada' using errcode = '42501'; end if;
  if s.pedido_id is not null then
    update pedidos set estado = est_ped where id = s.pedido_id;
    get diagnostics n = row_count; if n <> 1 then raise exception 'No se pudo actualizar el pedido' using errcode = '42501'; end if;
  end if;
  return jsonb_build_object('parada', parada, 'estado', est_p);
end $$;
revoke execute on function public.registrar_entrega(uuid, text, jsonb, jsonb) from public, anon;
grant execute on function public.registrar_entrega(uuid, text, jsonb, jsonb) to authenticated;

-- ZOH-001: cabecera y líneas de una orden de Zoho se guardan juntas. Una línea inválida revierte también la cabecera
--   (orden existente intacta; orden nueva sin filas). Solo la Edge Function "zoho" (service_role).
create or replace function public.zoho_guardar_pedido(pedido jsonb, lineas jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare ex pedidos; r pedidos; pid uuid; nuevo boolean;
begin
  if jsonb_typeof(lineas) <> 'array' or jsonb_array_length(lineas) = 0 then raise exception 'La orden % no tiene líneas', pedido->>'numero_so' using errcode = '22023'; end if;
  r := jsonb_populate_record(null::pedidos, pedido);
  select * into ex from pedidos where zoho_salesorder_id = r.zoho_salesorder_id for update;
  nuevo := not found;
  if nuevo then
    insert into pedidos (zoho_salesorder_id, numero_so, cliente_id, fecha, valor, peso_kg, volumen_m3, cajas, numero_factura, zoho_invoice_id, zoho_customer_id, origen, estado)
    values (r.zoho_salesorder_id, r.numero_so, r.cliente_id, r.fecha, r.valor, r.peso_kg, r.volumen_m3, r.cajas, r.numero_factura, r.zoho_invoice_id, r.zoho_customer_id, r.origen, 'pendiente_validar')
    returning id into pid;
  else
    pid := ex.id;
    update pedidos set numero_so = r.numero_so, cliente_id = r.cliente_id, fecha = r.fecha, valor = r.valor, peso_kg = r.peso_kg, volumen_m3 = r.volumen_m3,
           cajas = r.cajas, numero_factura = r.numero_factura, zoho_invoice_id = r.zoho_invoice_id, zoho_customer_id = r.zoho_customer_id, origen = r.origen, updated_at = now()
     where id = pid;
    delete from pedido_lineas where pedido_id = pid;
  end if;
  insert into pedido_lineas (pedido_id, sku, cantidad_cajas, precio, zoho_line_item_id)
  select pid, x.sku, x.cantidad_cajas, x.precio, x.zoho_line_item_id from jsonb_populate_recordset(null::pedido_lineas, lineas) x;
  return jsonb_build_object('id', pid, 'nuevo', nuevo, 'lineas', jsonb_array_length(lineas));
end $$;
revoke execute on function public.zoho_guardar_pedido(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.zoho_guardar_pedido(jsonb, jsonb) to service_role;

-- KNOWN-WA-002: un aviso que quedó en "enviando" (la función se cortó tras reclamarlo) se recupera pasados 10 minutos.
alter table notificaciones add column if not exists enviando_at timestamptz;
create or replace function public.wa_tomar_pendientes(n int default 20, ids uuid[] default null) returns setof notificaciones
language sql security definer set search_path = public, pg_temp as $$
  update notificaciones set estado = 'enviando', enviando_at = now(), intentos = coalesce(intentos,0) + 1
   where id in (select id from notificaciones
                 where (estado = 'pendiente'
                        or (estado = 'error' and coalesce(intentos,0) < 3)
                        or (estado = 'enviando' and wa_message_id is null and coalesce(intentos,0) < 3
                            and coalesce(enviando_at, created_at) < now() - interval '10 minutes'))
                   and (ids is null or id = any(ids))
                 order by created_at limit n for update skip locked)
  returning * $$;
revoke execute on function public.wa_tomar_pendientes(int, uuid[]) from public, anon, authenticated;
grant execute on function public.wa_tomar_pendientes(int, uuid[]) to service_role;
-- La versión privada antigua tampoco debe ser ejecutable por nadie más que su dueño
revoke execute on function dgp_private.tomar_pendientes(int, uuid) from public, anon, authenticated;
-- KNOWN-SEC-002: funciones nuevas del esquema privado sin EXECUTE público por defecto
alter default privileges in schema dgp_private revoke execute on functions from public;

-- KNOWN-WA-001: quien no tiene "notificaciones.enviar" (p. ej. el conductor) solo crea avisos de SUS rutas y a clientes de esas
--   rutas; el teléfono y la plantilla los decide el servidor (se ignora lo que mande el navegador).
create or replace function dgp_private.restringir_notificacion() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not dgp_private.es_usuario_app() or dgp_private.tiene('notificaciones.enviar') or coalesce(new.canal,'') not like 'whatsapp%' then return new; end if;
  if not (dgp_private.ruta_propia(new.ruta_id) or dgp_private.oficina()) then
    raise exception 'Solo puedes avisar a clientes de tus rutas' using errcode = '42501';
  end if;
  if new.cliente_id is null or (not dgp_private.oficina() and not exists (select 1 from paradas where ruta_id = new.ruta_id and cliente_id = new.cliente_id)) then
    raise exception 'El cliente del aviso no pertenece a la ruta' using errcode = '42501';
  end if;
  new.telefono := null; new.plantilla := null;   -- los deriva preparar_notificacion desde el cliente y el motivo
  new.destinatario := (select nombre from clientes where id = new.cliente_id);   -- sin teléfono escrito a mano en el texto
  return new;
end $$;
drop trigger if exists tr_00_restringir_notificacion on notificaciones;
create trigger tr_00_restringir_notificacion before insert on notificaciones for each row execute function dgp_private.restringir_notificacion();


select 'migracion 10c aplicada' as resultado;
