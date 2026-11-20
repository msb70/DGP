-- DGP · 20-nov-2026 · Cambio de conductor (2/2): «ejecutó» y «autorizó» usan el nombre del USUARIO (perfiles.nombre),
-- no el de la persona vinculada (mi_nombre() devuelve la persona: un perfil vinculado a un conductor demo saldría con ese nombre).
-- Aplicada en producción como cambio_conductor_nombre_usuario_20261120. Requiere 2026-11-20_cambio_conductor.sql.

CREATE OR REPLACE FUNCTION dgp_private.nombre_usuario()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(nullif(trim(f.nombre), ''), f.email) from perfiles f where f.id = auth.uid() $function$;

CREATE OR REPLACE FUNCTION public.autorizadores_conductor()
 RETURNS SETOF text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select distinct f.nombre from perfiles f join rol_permisos rp on rp.rol = f.rol and rp.permiso = 'conductor.cambiar'
  where f.activo and coalesce(trim(f.nombre), '') <> '' and dgp_private.oficina() order by 1 $function$;

CREATE OR REPLACE FUNCTION dgp_private.validar_cambio_conductor(es_cambio boolean, motivo text, autorizado text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if es_cambio then
    if not dgp_private.tiene('conductor.cambiar') then raise exception 'Cambiar o quitar un conductor requiere el permiso «conductor.cambiar»'; end if;
    if length(trim(coalesce(motivo, ''))) < 3 then raise exception 'Escribe el motivo del cambio de conductor'; end if;
    if nullif(trim(coalesce(autorizado, '')), '') is null then raise exception 'Indica quién autorizó el cambio'; end if;
    if not exists (select 1 from perfiles f join rol_permisos rp on rp.rol = f.rol and rp.permiso = 'conductor.cambiar'
                   where f.activo and f.nombre = trim(autorizado)) then
      raise exception '% no tiene permiso para autorizar cambios de conductor', autorizado;
    end if;
  elsif not (dgp_private.tiene('verificar') or dgp_private.tiene('planificar') or dgp_private.tiene('catalogo.editar') or dgp_private.tiene('conductor.cambiar')) then
    raise exception 'Tu rol no puede asignar conductores';
  end if;
end $function$;

CREATE OR REPLACE FUNCTION public.asignar_conductor(rid uuid, nombre text, motivo text DEFAULT NULL::text, autorizado text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  r record; v record; n text := nullif(trim(nombre), ''); ant text;
  abiertas text[] := array['simulada', 'aprobada', 'publicada', 'en_cargue'];
  quitado text[]; puestas text[]; vaciadas text[]; cambio boolean;
begin
  select * into r from rutas where id = rid for update;
  if not found then raise exception 'Ruta no encontrada'; end if;
  if not (r.estado = any(abiertas)) then raise exception 'La ruta % ya salió (%): su conductor no se cambia', r.codigo, r.estado; end if;
  if n is null then raise exception 'Elige un conductor'; end if;
  ant := nullif(trim(coalesce(r.conductor, '')), '');
  if ant = n then return jsonb_build_object('ok', true, 'sin_cambio', true); end if;
  cambio := ant is not null;
  perform dgp_private.validar_cambio_conductor(cambio, motivo, autorizado);
  if not exists (select 1 from personas p where p.nombre = n and p.rol = 'conductor' and coalesce(p.activo, true)) then
    raise exception 'El conductor % no existe o no está activo (Catálogo → Personas)', n;
  end if;
  if r.vehiculo_id is null then raise exception 'La ruta % no tiene vehículo', r.codigo; end if;
  select * into v from vehiculos where id = r.vehiculo_id for update;
  perform set_config('dgp.cambio_conductor', '1', true);
  select coalesce(array_agg(x.placa order by x.placa), '{}') into quitado from vehiculos x where x.conductor = n and x.id <> r.vehiculo_id;
  update vehiculos set conductor = null where conductor = n and id <> r.vehiculo_id;
  with u as (update rutas set conductor = null, updated_at = now()
              where conductor = n and vehiculo_id <> r.vehiculo_id and estado = any(abiertas) and fecha >= r.fecha returning codigo)
  select coalesce(array_agg(codigo order by codigo), '{}') into vaciadas from u;
  update vehiculos set conductor = n where id = r.vehiculo_id;
  with u as (update rutas set conductor = n, updated_at = now()
              where vehiculo_id = r.vehiculo_id and estado = any(abiertas) and fecha >= r.fecha returning codigo)
  select coalesce(array_agg(codigo order by codigo), '{}') into puestas from u;
  perform set_config('dgp.cambio_conductor', '', true);
  insert into conductor_cambios (tipo, ruta_id, ruta_codigo, ruta_fecha, vehiculo_id, placa, anterior, nuevo, es_cambio, motivo, autorizado_por, ejecutado_por, user_id, rutas_actualizadas, quitado_de, rutas_sin_conductor)
  values ('ruta', r.id, r.codigo, r.fecha, v.id, v.placa, ant, n, cambio, nullif(trim(coalesce(motivo, '')), ''), nullif(trim(coalesce(autorizado, '')), ''),
          coalesce(dgp_private.nombre_usuario(), 'sistema'), auth.uid(), puestas, quitado, vaciadas);
  insert into auditoria (entidad, entidad_id, accion, detalle, actor, automatico) values ('rutas', r.id, case when cambio then 'conductor_cambiado' else 'conductor_asignado' end,
    format('%s (%s): conductor %s → %s%s%s%s', r.codigo, v.placa, coalesce(ant, '—'), n,
      case when cambio then format(' · motivo: %s · autorizó: %s', trim(motivo), trim(autorizado)) else '' end,
      case when array_length(quitado, 1) > 0 then ' · se quitó de ' || array_to_string(quitado, ', ') else '' end,
      case when array_length(vaciadas, 1) > 0 then ' · quedan sin conductor ' || array_to_string(vaciadas, ', ') else '' end),
    coalesce(dgp_private.nombre_usuario(), 'sistema'), false);
  return jsonb_build_object('ok', true, 'placa', v.placa, 'quitado_de', quitado, 'rutas_actualizadas', coalesce(array_length(puestas, 1), 0), 'rutas', puestas,
    'rutas_sin_conductor', coalesce(array_length(vaciadas, 1), 0), 'vaciadas', vaciadas, 'cambio', cambio);
end $function$;

CREATE OR REPLACE FUNCTION public.asignar_conductor_vehiculo(vid uuid, nombre text, motivo text DEFAULT NULL::text, autorizado text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v record; n text := nullif(trim(nombre), ''); ant text;
  abiertas text[] := array['simulada', 'aprobada', 'publicada', 'en_cargue'];
  quitado text[] := '{}'; puestas text[]; vaciadas text[] := '{}'; cambio boolean; desde date := (now() at time zone 'America/Panama')::date;
begin
  select * into v from vehiculos where id = vid for update;
  if not found then raise exception 'Camión no encontrado'; end if;
  ant := nullif(trim(coalesce(v.conductor, '')), '');
  if ant is not distinct from n then return jsonb_build_object('ok', true, 'sin_cambio', true); end if;
  cambio := ant is not null;
  perform dgp_private.validar_cambio_conductor(cambio, motivo, autorizado);
  if n is not null and not exists (select 1 from personas p where p.nombre = n and p.rol = 'conductor' and coalesce(p.activo, true)) then
    raise exception 'El conductor % no existe o no está activo (Catálogo → Personas)', n;
  end if;
  perform set_config('dgp.cambio_conductor', '1', true);
  if n is not null then
    select coalesce(array_agg(x.placa order by x.placa), '{}') into quitado from vehiculos x where x.conductor = n and x.id <> vid;
    update vehiculos set conductor = null where conductor = n and id <> vid;
    with u as (update rutas set conductor = null, updated_at = now()
                where conductor = n and vehiculo_id <> vid and estado = any(abiertas) and fecha >= desde returning codigo)
    select coalesce(array_agg(codigo order by codigo), '{}') into vaciadas from u;
  end if;
  update vehiculos set conductor = n where id = vid;
  with u as (update rutas set conductor = n, updated_at = now()
              where vehiculo_id = vid and estado = any(abiertas) and fecha >= desde returning codigo)
  select coalesce(array_agg(codigo order by codigo), '{}') into puestas from u;
  perform set_config('dgp.cambio_conductor', '', true);
  insert into conductor_cambios (tipo, vehiculo_id, placa, anterior, nuevo, es_cambio, motivo, autorizado_por, ejecutado_por, user_id, rutas_actualizadas, quitado_de, rutas_sin_conductor)
  values ('camion', v.id, v.placa, ant, n, cambio, nullif(trim(coalesce(motivo, '')), ''), nullif(trim(coalesce(autorizado, '')), ''),
          coalesce(dgp_private.nombre_usuario(), 'sistema'), auth.uid(), puestas, quitado, vaciadas);
  insert into auditoria (entidad, entidad_id, accion, detalle, actor, automatico) values ('vehiculos', v.id, case when cambio then 'conductor_cambiado' else 'conductor_asignado' end,
    format('Camión %s: conductor %s → %s%s · viajes abiertos: %s%s%s', v.placa, coalesce(ant, '—'), coalesce(n, 'sin conductor'),
      case when cambio then format(' · motivo: %s · autorizó: %s', trim(motivo), trim(autorizado)) else '' end,
      coalesce(nullif(array_to_string(puestas, ', '), ''), 'ninguno'),
      case when array_length(quitado, 1) > 0 then ' · se quitó de ' || array_to_string(quitado, ', ') else '' end,
      case when array_length(vaciadas, 1) > 0 then ' · quedan sin conductor ' || array_to_string(vaciadas, ', ') else '' end),
    coalesce(dgp_private.nombre_usuario(), 'sistema'), false);
  return jsonb_build_object('ok', true, 'placa', v.placa, 'quitado_de', quitado, 'rutas_actualizadas', coalesce(array_length(puestas, 1), 0), 'rutas', puestas,
    'rutas_sin_conductor', coalesce(array_length(vaciadas, 1), 0), 'vaciadas', vaciadas, 'cambio', cambio);
end $function$;
