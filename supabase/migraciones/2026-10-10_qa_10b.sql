-- DGP · Migración 10b (endurecimiento QA 10-oct-2026). Idempotente: se puede ejecutar más de una vez.
-- Pegar completo en Supabase → SQL Editor → Run. Equivale a la sección 10b de v3_produccion.sql + política de paquetes.
-- Política de paquetes: el conductor ya no actualiza paquetes (SEG-01/06)
drop policy if exists p_upd on paquetes;
create policy p_upd on paquetes for update to authenticated using (dgp_private.escribe('paquetes')) with check (dgp_private.escribe('paquetes'));
-- ---------------------------------------------------------------------
-- 10b. Endurecimiento tras la validación QA del 10-oct-2026 (docs/validacion-2026-10-10)
-- ---------------------------------------------------------------------
-- SEG-01/05: el conductor solo cambia, en sus rutas, las columnas que usa la app y con transiciones válidas.
--   La RLS decide QUÉ filas; este trigger decide QUÉ columnas y QUÉ estados. Oficina (escribe(tabla)) y el
--   servidor (service_role / SQL Editor, sin auth.uid()) no pasan por aquí.
--   TG_ARGV[0] = columnas permitidas (coma) · TG_ARGV[1] = transiciones de estado permitidas 'a>b,c>d' ('' = ninguna).
create or replace function dgp_private.guardia_conductor() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare libres text[] := string_to_array(TG_ARGV[0], ','); trans text[] := string_to_array(coalesce(TG_ARGV[1], ''), ',');
begin
  if auth.uid() is null or dgp_private.escribe(TG_TABLE_NAME) then return new; end if;
  if (to_jsonb(new) - libres) is distinct from (to_jsonb(old) - libres) then
    raise exception 'El conductor no puede modificar esos datos de %', TG_TABLE_NAME using errcode = '42501';
  end if;
  if 'estado' = any(libres) and new.estado is distinct from old.estado
     and not (old.estado || '>' || new.estado) = any(trans) then
    raise exception 'Cambio de estado no permitido para el conductor en %: % → %', TG_TABLE_NAME, old.estado, new.estado using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists tr_guardia_conductor on rutas;
create trigger tr_guardia_conductor before update on rutas for each row execute function dgp_private.guardia_conductor(
  'estado,area_cargue_at,verificador_llamado_at,salida_at,odometro_salida,pallets_salida,version,hora_fin_prevista,pallets_retorno,pallets_buen_estado,llegada_at,odometro_llegada,km_real,updated_at',
  'liberada>en_ruta,en_ruta>cerrada');
drop trigger if exists tr_guardia_conductor on paradas;
create trigger tr_guardia_conductor before update on paradas for each row execute function dgp_private.guardia_conductor(
  'estado,checkin_at,checkin_lat,checkin_lng,distancia_checkin_m,checkout_at,fotos,foto,receptor,firma,resultado,eta,updated_at',
  'pendiente>en_sitio,pendiente>atendida,en_sitio>atendida,en_sitio>parcial,en_sitio>no_entregada,pendiente>parcial,pendiente>no_entregada');
drop trigger if exists tr_guardia_conductor on pedidos;
create trigger tr_guardia_conductor before update on pedidos for each row execute function dgp_private.guardia_conductor(
  'estado,updated_at', 'planificado>entregado,planificado>parcial,planificado>no_entregado');
drop trigger if exists tr_guardia_conductor on pedido_lineas;
create trigger tr_guardia_conductor before update on pedido_lineas for each row execute function dgp_private.guardia_conductor('entregado', '');

-- DAT-03: dominio cerrado de estados (los mismos que documenta el esquema y usa la aplicación)
do $$ begin
  alter table rutas drop constraint if exists ck_rutas_estado;
  alter table rutas add constraint ck_rutas_estado check (estado in ('simulada','aprobada','publicada','en_cargue','liberada','en_ruta','cerrada','conciliada'));
  alter table pedidos drop constraint if exists ck_pedidos_estado;
  alter table pedidos add constraint ck_pedidos_estado check (estado in ('pendiente_validar','elegible','en_excepcion','planificado','pendiente_autorizacion','diferido','entregado','parcial','no_entregado','cancelado'));
  alter table paradas drop constraint if exists ck_paradas_estado;
  alter table paradas add constraint ck_paradas_estado check (estado in ('pendiente','en_sitio','atendida','parcial','no_entregada','reprogramada'));
  alter table paquetes drop constraint if exists ck_paquetes_estado;
  alter table paquetes add constraint ck_paquetes_estado check (estado in ('pendiente','impreso','en_area','verificado','firmado','registrado','en_bodega','entregado_gd'));
end $$;

-- DAT-02: cantidades, importes y capacidades no negativos (las devoluciones se expresan con "entregado" < cantidad, no con negativos)
do $$ begin
  alter table pedido_lineas drop constraint if exists ck_lineas_no_negativas;
  alter table pedido_lineas add constraint ck_lineas_no_negativas check (cantidad_cajas >= 0 and (precio is null or precio >= 0) and (entregado is null or (entregado >= 0 and entregado <= cantidad_cajas)));
  alter table pedidos drop constraint if exists ck_pedidos_no_negativos;
  alter table pedidos add constraint ck_pedidos_no_negativos check (coalesce(valor,0) >= 0 and coalesce(cajas,0) >= 0 and coalesce(peso_kg,0) >= 0 and coalesce(volumen_m3,0) >= 0);
  alter table vehiculos drop constraint if exists ck_vehiculos_capacidad;
  alter table vehiculos add constraint ck_vehiculos_capacidad check (coalesce(cap_cajas,0) >= 0 and coalesce(cap_peso_kg,0) >= 0 and coalesce(cap_volumen_m3,0) >= 0);
  alter table rutas drop constraint if exists ck_rutas_odometro;
  alter table rutas add constraint ck_rutas_odometro check (odometro_llegada is null or odometro_salida is null or odometro_llegada >= odometro_salida);
end $$;

-- SEG-06: las firmas solo pueden ser imágenes PNG/JPEG en data URL (nada de texto que rompa el atributo src)
do $$ begin
  alter table paquetes drop constraint if exists ck_paquetes_firmas;
  alter table paquetes add constraint ck_paquetes_firmas check (
    (firma_conductor is null or firma_conductor ~ '^data:image/(png|jpeg);base64,[A-Za-z0-9+/=]+$') and
    (firma_verificador is null or firma_verificador ~ '^data:image/(png|jpeg);base64,[A-Za-z0-9+/=]+$'));
end $$;

-- FUN-05: un solo registro en Zoho a la vez por paquete (la Edge Function "zoho" reclama el paquete antes de llamar a Zoho)
alter table paquetes add column if not exists zoho_bloqueo_at timestamptz;
create or replace function public.zoho_reclamar_paquete(pid uuid) returns boolean
language sql security definer set search_path = public, pg_temp as $$
  with c as (update paquetes set zoho_bloqueo_at = now() where id = pid
               and (books_shipment_id is null or books_shipment_id like 'SIM-%')
               and (zoho_bloqueo_at is null or zoho_bloqueo_at < now() - interval '2 minutes') returning 1)
  select exists (select 1 from c) $$;
revoke execute on function public.zoho_reclamar_paquete(uuid) from public, anon, authenticated;
grant execute on function public.zoho_reclamar_paquete(uuid) to service_role;

-- COD-06 (servidor): la base de Supabase corre en UTC; las fechas operativas por defecto se toman en hora de Panamá
alter table pedidos alter column fecha set default ((now() at time zone 'America/Panama')::date);
alter table rutas alter column fecha set default ((now() at time zone 'America/Panama')::date);
alter table actas_gd alter column fecha set default ((now() at time zone 'America/Panama')::date);

select 'migracion 10b aplicada' as resultado;
