-- DGP · Módulo «Cambio de conductor» con historial, permiso y autorización (20-nov-2026). Idempotente.
-- · Permiso conductor.cambiar: cambiar o quitar el conductor que ya tiene una ruta o un camión (admin y gerente de operaciones;
--   ampliable en Usuarios y permisos). La primera asignación (ruta/camión sin conductor) sigue permitida a verificar/planificar.
-- · Vista ver.conductores para los roles que verifican o planifican.
-- · Historial inmutable conductor_cambios: qué cambió, motivo, quién lo autorizó (usuario con conductor.cambiar) y quién lo hizo.
-- · Solo se cambia el conductor por asignar_conductor / asignar_conductor_vehiculo: un trigger bloquea cambios directos en
--   rutas.conductor y vehiculos.conductor (la API, la importación CSV, etc.). Las rutas nuevas sí se crean con el del camión.

-- 1. Permisos
insert into public.permisos (codigo, modulo, nombre, orden) values
  ('conductor.cambiar', 'Operación', 'Cambiar o quitar el conductor de una ruta o camión', 40),
  ('ver.conductores', 'Vistas', 'Cambio de conductor', 7)
on conflict (codigo) do nothing;
insert into public.rol_permisos (rol, permiso)
select r, 'conductor.cambiar' from unnest(array['admin', 'gerente_operaciones']) r
where not exists (select 1 from public.rol_permisos x where x.rol = r and x.permiso = 'conductor.cambiar');
insert into public.rol_permisos (rol, permiso)
select distinct rp.rol, 'ver.conductores' from public.rol_permisos rp
where rp.permiso in ('verificar', 'planificar', 'conductor.cambiar')
  and not exists (select 1 from public.rol_permisos x where x.rol = rp.rol and x.permiso = 'ver.conductores');

-- 2. Historial
create table if not exists public.conductor_cambios (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  tipo                text not null check (tipo in ('ruta', 'camion')),
  ruta_id             uuid,
  ruta_codigo         text,
  ruta_fecha          date,
  vehiculo_id         uuid,
  placa               text,
  anterior            text,
  nuevo               text,
  es_cambio           boolean not null,          -- false = primera asignación (no tenía conductor)
  motivo              text,
  autorizado_por      text,                      -- usuario con conductor.cambiar que lo permitió
  ejecutado_por       text not null,
  user_id             uuid,
  rutas_actualizadas  text[] not null default '{}',
  quitado_de          text[] not null default '{}',
  rutas_sin_conductor text[] not null default '{}'
);
create index if not exists conductor_cambios_fecha on public.conductor_cambios (created_at desc);
alter table public.conductor_cambios enable row level security;
revoke all on public.conductor_cambios from anon, authenticated;
grant select on public.conductor_cambios to authenticated;
drop policy if exists p_sel on public.conductor_cambios;
create policy p_sel on public.conductor_cambios for select to authenticated using (dgp_private.oficina());

-- 3. Quién puede autorizar (para el desplegable «Autorizado por»)
create or replace function public.autorizadores_conductor() returns setof text
language sql stable security definer set search_path = public, pg_temp as $$
  select distinct coalesce(p.nombre, f.nombre) from perfiles f left join personas p on p.id = f.persona_id
   join rol_permisos rp on rp.rol = f.rol and rp.permiso = 'conductor.cambiar'
  where f.activo and dgp_private.oficina() order by 1 $$;
revoke all on function public.autorizadores_conductor() from public, anon;
grant execute on function public.autorizadores_conductor() to authenticated;

-- 4. Guardia: el conductor solo se cambia por las funciones del módulo
create or replace function dgp_private.guardia_cambio_conductor() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if coalesce(current_setting('dgp.cambio_conductor', true), '') = '1' then return new; end if;
  if auth.uid() is null then return new; end if;                         -- service role / tareas internas
  if new.conductor is distinct from old.conductor then
    raise exception 'El conductor se cambia en «Cambio de conductor» (queda en el historial con quién lo autorizó)';
  end if;
  return new;
end $$;
drop trigger if exists tr_guardia_cambio_conductor on public.rutas;
create trigger tr_guardia_cambio_conductor before update of conductor on public.rutas
for each row execute function dgp_private.guardia_cambio_conductor();
drop trigger if exists tr_guardia_cambio_conductor on public.vehiculos;
create trigger tr_guardia_cambio_conductor before update of conductor on public.vehiculos
for each row execute function dgp_private.guardia_cambio_conductor();

-- 5. Validación común de permiso/autorización
create or replace function dgp_private.validar_cambio_conductor(es_cambio boolean, motivo text, autorizado text) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if es_cambio then
    if not dgp_private.tiene('conductor.cambiar') then raise exception 'Cambiar o quitar un conductor requiere el permiso «conductor.cambiar»'; end if;
    if length(trim(coalesce(motivo, ''))) < 3 then raise exception 'Escribe el motivo del cambio de conductor'; end if;
    if nullif(trim(coalesce(autorizado, '')), '') is null then raise exception 'Indica quién autorizó el cambio'; end if;
    if not exists (select 1 from perfiles f left join personas p on p.id = f.persona_id join rol_permisos rp on rp.rol = f.rol and rp.permiso = 'conductor.cambiar'
                   where f.activo and coalesce(p.nombre, f.nombre) = trim(autorizado)) then
      raise exception '% no tiene permiso para autorizar cambios de conductor', autorizado;
    end if;
  elsif not (dgp_private.tiene('verificar') or dgp_private.tiene('planificar') or dgp_private.tiene('catalogo.editar') or dgp_private.tiene('conductor.cambiar')) then
    raise exception 'Tu rol no puede asignar conductores';
  end if;
end $$;

-- 6. Por ruta (sustituye a la versión de 2 parámetros)
drop function if exists public.asignar_conductor(uuid, text);
create or replace function public.asignar_conductor(rid uuid, nombre text, motivo text default null, autorizado text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
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
          coalesce(dgp_private.mi_nombre(), 'sistema'), auth.uid(), puestas, quitado, vaciadas);
  insert into auditoria (entidad, entidad_id, accion, detalle, actor, automatico) values ('rutas', r.id, case when cambio then 'conductor_cambiado' else 'conductor_asignado' end,
    format('%s (%s): conductor %s → %s%s%s%s', r.codigo, v.placa, coalesce(ant, '—'), n,
      case when cambio then format(' · motivo: %s · autorizó: %s', trim(motivo), trim(autorizado)) else '' end,
      case when array_length(quitado, 1) > 0 then ' · se quitó de ' || array_to_string(quitado, ', ') else '' end,
      case when array_length(vaciadas, 1) > 0 then ' · quedan sin conductor ' || array_to_string(vaciadas, ', ') else '' end),
    coalesce(dgp_private.mi_nombre(), 'sistema'), false);
  return jsonb_build_object('ok', true, 'placa', v.placa, 'quitado_de', quitado, 'rutas_actualizadas', coalesce(array_length(puestas, 1), 0), 'rutas', puestas,
    'rutas_sin_conductor', coalesce(array_length(vaciadas, 1), 0), 'vaciadas', vaciadas, 'cambio', cambio);
end $$;
revoke all on function public.asignar_conductor(uuid, text, text, text) from public, anon;
grant execute on function public.asignar_conductor(uuid, text, text, text) to authenticated;

-- 7. Por camión (nombre null = quitar el conductor del camión y de sus viajes que aún no salieron)
create or replace function public.asignar_conductor_vehiculo(vid uuid, nombre text, motivo text default null, autorizado text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
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
          coalesce(dgp_private.mi_nombre(), 'sistema'), auth.uid(), puestas, quitado, vaciadas);
  insert into auditoria (entidad, entidad_id, accion, detalle, actor, automatico) values ('vehiculos', v.id, case when cambio then 'conductor_cambiado' else 'conductor_asignado' end,
    format('Camión %s: conductor %s → %s%s · viajes abiertos: %s%s%s', v.placa, coalesce(ant, '—'), coalesce(n, 'sin conductor'),
      case when cambio then format(' · motivo: %s · autorizó: %s', trim(motivo), trim(autorizado)) else '' end,
      coalesce(nullif(array_to_string(puestas, ', '), ''), 'ninguno'),
      case when array_length(quitado, 1) > 0 then ' · se quitó de ' || array_to_string(quitado, ', ') else '' end,
      case when array_length(vaciadas, 1) > 0 then ' · quedan sin conductor ' || array_to_string(vaciadas, ', ') else '' end),
    coalesce(dgp_private.mi_nombre(), 'sistema'), false);
  return jsonb_build_object('ok', true, 'placa', v.placa, 'quitado_de', quitado, 'rutas_actualizadas', coalesce(array_length(puestas, 1), 0), 'rutas', puestas,
    'rutas_sin_conductor', coalesce(array_length(vaciadas, 1), 0), 'vaciadas', vaciadas, 'cambio', cambio);
end $$;
revoke all on function public.asignar_conductor_vehiculo(uuid, text, text, text) from public, anon;
grant execute on function public.asignar_conductor_vehiculo(uuid, text, text, text) to authenticated;
