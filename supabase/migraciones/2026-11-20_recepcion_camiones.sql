-- DGP · Recepción del camión al regreso del viaje (20-nov-2026). Idempotente. Aplicada como recepcion_camiones_20261120.
-- Acta firmada por el conductor (entrega) y por bodega (recibe) con todo el detalle del viaje: entregas, devoluciones
-- (contadas en bodega), incidentes, cobros, odómetro y pallets. Una recepción por viaje; el acta no se modifica.
-- Si el conductor no registró la llegada en su app, la recepción puede cerrar la ruta con el odómetro de llegada.

insert into public.permisos (codigo, modulo, nombre, orden) values
  ('recepcion.registrar', 'Operación', 'Recibir el camión al regreso y firmar el acta de recepción', 43),
  ('ver.recepcion',       'Vistas',    'Recepción de camiones', 8)
on conflict (codigo) do nothing;
insert into public.rol_permisos (rol, permiso)
select x.rol, 'recepcion.registrar' from (values ('admin'), ('encargado_bodega'), ('bodega'), ('verificador'), ('gerente_operaciones')) x(rol)
where exists (select 1 from public.roles r where r.codigo = x.rol)
  and not exists (select 1 from public.rol_permisos rp where rp.rol = x.rol and rp.permiso = 'recepcion.registrar');
insert into public.rol_permisos (rol, permiso)
select distinct rp.rol, 'ver.recepcion' from public.rol_permisos rp
where rp.permiso in ('recepcion.registrar', 'ver.verif', 'ver.seguimiento')
  and not exists (select 1 from public.rol_permisos x where x.rol = rp.rol and x.permiso = 'ver.recepcion');

create table if not exists public.recepciones (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  ruta_id          uuid not null unique references public.rutas(id),
  ruta_codigo      text,
  ruta_fecha       date,
  placa            text,
  conductor        text,                 -- entrega
  firma_conductor  text not null,
  recibe           text not null,        -- bodega
  firma_recibe     text not null,
  registrado_por   text not null,
  odometro_llegada numeric,
  pallets_retorno  integer,
  pallets_buen_estado boolean,
  observaciones    text,
  devoluciones     jsonb not null default '[]'::jsonb,   -- [{factura, cliente, sku, articulo, esperado, recibido}]
  diferencias      integer not null default 0,           -- líneas de devolución con cantidad distinta
  resumen          jsonb not null default '{}'::jsonb     -- foto del viaje al recibir: entregas, incidentes, cobros, km
);
alter table public.recepciones enable row level security;
revoke all on public.recepciones from anon, authenticated;
grant select on public.recepciones to authenticated;
drop policy if exists p_sel on public.recepciones;
create policy p_sel on public.recepciones for select to authenticated using (dgp_private.oficina() or dgp_private.ruta_propia(ruta_id));

create or replace function public.registrar_recepcion(rid uuid, recibe text, firma_recibe text, firma_conductor text,
    devoluciones jsonb default '[]'::jsonb, resumen jsonb default '{}'::jsonb, observaciones text default null,
    odometro numeric default null, pallets_retorno integer default null, pallets_buen_estado boolean default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; v record; nid uuid; dif int := 0; quien text := coalesce(dgp_private.nombre_usuario(), 'sistema'); d jsonb;
begin
  if not dgp_private.tiene('recepcion.registrar') then raise exception 'Recibir camiones requiere el permiso «recepcion.registrar»'; end if;
  select * into r from rutas where id = rid for update;
  if not found then raise exception 'Viaje no encontrado'; end if;
  if exists (select 1 from recepciones x where x.ruta_id = rid) then raise exception 'El viaje % ya fue recibido', r.codigo; end if;
  if r.estado not in ('en_ruta', 'cerrada', 'conciliada') then raise exception 'El viaje % no ha salido (%)', r.codigo, r.estado; end if;
  if length(trim(coalesce(recibe, ''))) < 3 then raise exception 'Escribe el nombre de quien recibe en bodega'; end if;
  if firma_recibe is null or firma_recibe !~ '^data:image/png;base64,' or length(firma_recibe) < 1500 then raise exception 'Falta la firma de quien recibe en bodega'; end if;
  if firma_conductor is null or firma_conductor !~ '^data:image/png;base64,' or length(firma_conductor) < 1500 then raise exception 'Falta la firma del conductor'; end if;
  if jsonb_typeof(coalesce(devoluciones, '[]'::jsonb)) <> 'array' then raise exception 'Devoluciones inválidas'; end if;
  for d in select * from jsonb_array_elements(coalesce(devoluciones, '[]'::jsonb)) loop
    if (d->>'recibido') is null or (d->>'recibido')::numeric < 0 then raise exception 'Cuenta la devolución de % (%)', d->>'sku', d->>'factura'; end if;
    if (d->>'recibido')::numeric <> coalesce((d->>'esperado')::numeric, 0) then dif := dif + 1; end if;
  end loop;
  if dif > 0 and length(trim(coalesce(observaciones, ''))) < 3 then raise exception 'Hay % devolución(es) con diferencia: explica en observaciones', dif; end if;
  -- el conductor no registró la llegada en su app: la cierra la recepción (el trigger exige odómetro válido)
  if r.estado = 'en_ruta' then
    if odometro is null then raise exception 'El conductor no registró la llegada: escribe el odómetro de llegada'; end if;
    update rutas set estado = 'cerrada', llegada_at = now(), odometro_llegada = odometro,
           km_real = case when odometro_salida is not null then odometro - odometro_salida end,
           pallets_retorno = coalesce(registrar_recepcion.pallets_retorno, rutas.pallets_retorno), pallets_buen_estado = coalesce(registrar_recepcion.pallets_buen_estado, rutas.pallets_buen_estado)
     where id = rid;
    select * into r from rutas where id = rid;
  elsif registrar_recepcion.pallets_retorno is not null then
    update rutas set pallets_retorno = registrar_recepcion.pallets_retorno, pallets_buen_estado = coalesce(registrar_recepcion.pallets_buen_estado, rutas.pallets_buen_estado) where id = rid;
    select * into r from rutas where id = rid;
  end if;
  select * into v from vehiculos where id = r.vehiculo_id;
  insert into recepciones (ruta_id, ruta_codigo, ruta_fecha, placa, conductor, firma_conductor, recibe, firma_recibe, registrado_por, odometro_llegada,
                           pallets_retorno, pallets_buen_estado, observaciones, devoluciones, diferencias, resumen)
  values (rid, r.codigo, r.fecha, v.placa, r.conductor, firma_conductor, trim(recibe), firma_recibe, quien, r.odometro_llegada,
          r.pallets_retorno, r.pallets_buen_estado, nullif(trim(coalesce(observaciones, '')), ''), coalesce(devoluciones, '[]'::jsonb), dif, coalesce(resumen, '{}'::jsonb))
  returning id into nid;
  insert into auditoria (entidad, entidad_id, accion, detalle, actor, automatico) values ('recepciones', nid, 'camion_recibido',
    format('%s (%s) · %s · conductor %s · recibe %s · %s devoluciones%s', r.codigo, r.fecha, coalesce(v.placa, ''), coalesce(r.conductor, '—'), trim(recibe),
           jsonb_array_length(coalesce(devoluciones, '[]'::jsonb)), case when dif > 0 then ' · ' || dif || ' con diferencia' else '' end), quien, false);
  if dif > 0 then
    insert into alertas (tipo, severidad, titulo, detalle, entidad, destinatario, created_at)
    values ('recepcion', 'alta', format('%s: devoluciones con diferencia al recibir el camión', r.codigo),
            format('%s línea(s) no cuadran. Observaciones: %s', dif, trim(observaciones)), 'ruta', 'Encargado de bodega', now());
  end if;
  return jsonb_build_object('ok', true, 'id', nid, 'diferencias', dif);
end $$;
revoke all on function public.registrar_recepcion(uuid, text, text, text, jsonb, jsonb, text, numeric, integer, boolean) from public, anon;
grant execute on function public.registrar_recepcion(uuid, text, text, text, jsonb, jsonb, text, numeric, integer, boolean) to authenticated;
