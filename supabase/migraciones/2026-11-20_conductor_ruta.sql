-- DGP · Conductor obligatorio para liberar, asignación ruta ↔ vehículo y vista «Viajes por conductor» (20-nov-2026). Idempotente.
-- Reglas:
--  · Una ruta no pasa a «liberada» sin conductor (trigger: también protege llamadas directas a la API).
--  · asignar_conductor(ruta, nombre): el conductor queda en la ruta, en su vehículo y en los demás viajes abiertos de ese
--    vehículo (misma fecha o posteriores). Si estaba en otro vehículo, se quita de ese vehículo y de sus viajes abiertos.
--  · Permiso de vista ver.viajes para los roles que ya ven el seguimiento.

-- 1. Permiso de la vista
insert into public.permisos (codigo, modulo, nombre, orden) values ('ver.viajes', 'Vistas', 'Viajes por conductor', 6)
on conflict (codigo) do nothing;
insert into public.rol_permisos (rol, permiso)
select distinct rp.rol, 'ver.viajes' from public.rol_permisos rp
where rp.permiso = 'ver.seguimiento' and not exists (select 1 from public.rol_permisos x where x.rol = rp.rol and x.permiso = 'ver.viajes');

-- 2. Asignación de conductor (atómica)
create or replace function public.asignar_conductor(rid uuid, nombre text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record; v record; n text := nullif(trim(nombre), '');
  abiertas text[] := array['simulada', 'aprobada', 'publicada', 'en_cargue'];
  quitado text[]; nr int := 0; nq int := 0;
begin
  if not (dgp_private.tiene('verificar') or dgp_private.tiene('planificar') or dgp_private.tiene('catalogo.editar')) then
    raise exception 'Tu rol no puede asignar conductores';
  end if;
  select * into r from rutas where id = rid for update;
  if not found then raise exception 'Ruta no encontrada'; end if;
  if not (r.estado = any(abiertas)) then raise exception 'La ruta % ya salió (%): su conductor no se cambia', r.codigo, r.estado; end if;
  if n is null then raise exception 'Elige un conductor'; end if;
  if not exists (select 1 from personas p where p.nombre = n and p.rol = 'conductor' and coalesce(p.activo, true)) then
    raise exception 'El conductor % no existe o no está activo (Catálogo → Personas)', n;
  end if;
  if r.vehiculo_id is null then raise exception 'La ruta % no tiene vehículo', r.codigo; end if;
  select * into v from vehiculos where id = r.vehiculo_id for update;
  -- quitarlo de otros vehículos y de sus viajes que aún no salieron
  select coalesce(array_agg(x.placa order by x.placa), '{}') into quitado from vehiculos x where x.conductor = n and x.id <> r.vehiculo_id;
  update vehiculos set conductor = null where conductor = n and id <> r.vehiculo_id;
  update rutas set conductor = null, updated_at = now()
   where conductor = n and vehiculo_id <> r.vehiculo_id and estado = any(abiertas) and fecha >= r.fecha;
  get diagnostics nq = row_count;
  -- asignarlo a este vehículo y a sus viajes abiertos
  update vehiculos set conductor = n where id = r.vehiculo_id;
  update rutas set conductor = n, updated_at = now() where vehiculo_id = r.vehiculo_id and estado = any(abiertas) and fecha >= r.fecha;
  get diagnostics nr = row_count;
  insert into auditoria (entidad, entidad_id, accion, detalle, actor, automatico) values ('rutas', r.id, 'conductor_asignado',
    format('%s: conductor %s → %s en %s (%s viaje(s) abiertos de ese camión)%s%s', r.codigo, coalesce(r.conductor, '—'), n, v.placa, nr,
      case when array_length(quitado, 1) > 0 then '; se quitó de ' || array_to_string(quitado, ', ') else '' end,
      case when nq > 0 then format('; %s viaje(s) de ese otro camión quedan sin conductor', nq) else '' end),
    coalesce(dgp_private.mi_nombre(), 'sistema'), false);
  return jsonb_build_object('ok', true, 'placa', v.placa, 'quitado_de', quitado, 'rutas_actualizadas', nr, 'rutas_sin_conductor', nq);
end $$;
revoke all on function public.asignar_conductor(uuid, text) from public, anon;
grant execute on function public.asignar_conductor(uuid, text) to authenticated;

-- 3. No liberar sin conductor
create or replace function dgp_private.liberar_con_conductor() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.estado = 'liberada' and old.estado is distinct from 'liberada' and coalesce(trim(new.conductor), '') = '' then
    raise exception 'La ruta % no tiene conductor asignado: asígnalo antes de liberar la mercancía', new.codigo;
  end if;
  return new;
end $$;
drop trigger if exists tr_liberar_con_conductor on public.rutas;
create trigger tr_liberar_con_conductor before update of estado on public.rutas
for each row execute function dgp_private.liberar_con_conductor();
