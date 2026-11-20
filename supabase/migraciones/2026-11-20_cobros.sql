-- DGP · Módulo «Cobros en ruta» (20-nov-2026). Idempotente. Aplicada como cobros_20261120.
-- · La oficina asigna cobros a un viaje: cliente, monto, forma (efectivo / cheque; cheque exige banco y número).
-- · El conductor marca en su app «Recibido» o «No recibido» con causa del catálogo causas_no_cobro (registrar_cobro).
-- · Al regreso, quien recibe el dinero lo confirma con nombre y firma: el cobro pasa a «entregado» (liquidar_cobros).
-- · Estados: pendiente → recibido | no_recibido → (recibido) entregado; pendiente | no_recibido → anulado (oficina).
--   El estado solo cambia por las funciones del módulo (salvo anular un cobro pendiente o no recibido).

-- 1. Permisos
insert into public.permisos (codigo, modulo, nombre, orden) values
  ('cobros.gestionar', 'Operación', 'Crear, editar y anular cobros asignados a viajes', 41),
  ('cobros.liquidar',  'Operación', 'Recibir el efectivo y cheques al regreso del viaje (con firma)', 42),
  ('ver.cobros',       'Vistas',    'Cobros en ruta', 8)
on conflict (codigo) do nothing;
insert into public.rol_permisos (rol, permiso)
select x.rol, x.permiso from (values
  ('admin', 'cobros.gestionar'), ('cxc', 'cobros.gestionar'), ('gerente_comercial', 'cobros.gestionar'), ('gerente_operaciones', 'cobros.gestionar'), ('facturacion', 'cobros.gestionar'),
  ('admin', 'cobros.liquidar'), ('cxc', 'cobros.liquidar'), ('gerente_operaciones', 'cobros.liquidar'), ('encargado_bodega', 'cobros.liquidar')) x(rol, permiso)
where exists (select 1 from public.roles r where r.codigo = x.rol)
  and not exists (select 1 from public.rol_permisos rp where rp.rol = x.rol and rp.permiso = x.permiso);
insert into public.rol_permisos (rol, permiso)
select distinct rp.rol, 'ver.cobros' from public.rol_permisos rp
where rp.permiso in ('cobros.gestionar', 'cobros.liquidar')
  and not exists (select 1 from public.rol_permisos x where x.rol = rp.rol and x.permiso = 'ver.cobros');

-- 2. Catálogo de causas de no cobro (se desactivan, no se borran)
create table if not exists public.causas_no_cobro (
  codigo        text primary key check (codigo ~ '^[a-z0-9_]{1,30}$'),
  nombre        text not null check (length(trim(nombre)) between 3 and 120),
  requiere_nota boolean not null default false,
  orden         integer,
  activa        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.causas_no_cobro enable row level security;
revoke all on public.causas_no_cobro from anon;
grant select, insert, update on public.causas_no_cobro to authenticated;
insert into dgp_private.tabla_permisos (tabla, permisos) values ('causas_no_cobro', array['catalogo.editar'])
on conflict (tabla) do update set permisos = excluded.permisos;
drop policy if exists p_sel on public.causas_no_cobro;
drop policy if exists p_ins on public.causas_no_cobro;
drop policy if exists p_upd on public.causas_no_cobro;
create policy p_sel on public.causas_no_cobro for select to authenticated using (dgp_private.perfil_activo());
create policy p_ins on public.causas_no_cobro for insert to authenticated with check (dgp_private.escribe('causas_no_cobro'));
create policy p_upd on public.causas_no_cobro for update to authenticated using (dgp_private.escribe('causas_no_cobro')) with check (dgp_private.escribe('causas_no_cobro'));
drop trigger if exists tr_sin_html on public.causas_no_cobro;
create trigger tr_sin_html before insert or update on public.causas_no_cobro for each row execute function dgp_private.sin_html();
insert into public.causas_no_cobro (codigo, nombre, requiere_nota, orden) values
  ('ausente',        'No estaba el cliente o la persona autorizada a pagar', false, 1),
  ('sin_fondos',     'Cliente sin efectivo o sin fondos para pagar', false, 2),
  ('cheque_no_listo','Cheque no estaba listo o faltaba la firma', false, 3),
  ('cheque_errores', 'Cheque con errores (monto, fecha, beneficiario o firma)', true, 4),
  ('disputa',        'Cliente no está de acuerdo con el monto o la factura', true, 5),
  ('ya_pago',        'Cliente indica que ya pagó (transferencia o depósito)', false, 6),
  ('transferencia',  'Pagará por transferencia o depósito', false, 7),
  ('otro_dia',       'Cliente pide que se pase otro día', false, 8),
  ('cerrado',        'Local cerrado', false, 9),
  ('no_visitado',    'No se visitó al cliente (tiempo, ruta o incidente)', false, 10),
  ('otra',           'Otra (explicar en la nota)', true, 99)
on conflict (codigo) do nothing;

-- 3. Cobros
create table if not exists public.cobros (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  ruta_id            uuid not null references public.rutas(id),
  cliente_id         uuid not null references public.clientes(id),
  pedido_id          uuid references public.pedidos(id),
  documento          text,                                   -- factura(s) o referencia que se cobra
  monto              numeric(12,2) not null check (monto > 0),
  forma              text not null check (forma in ('efectivo', 'cheque')),
  banco              text,
  numero_cheque      text,
  notas              text,
  estado             text not null default 'pendiente' check (estado in ('pendiente', 'recibido', 'no_recibido', 'entregado', 'anulado')),
  creado_por         text,
  -- gestión del conductor
  conductor          text,
  gestion_at         timestamptz,
  gestion_lat        double precision,
  gestion_lng        double precision,
  monto_recibido     numeric(12,2) check (monto_recibido is null or monto_recibido > 0),
  causa_codigo       text references public.causas_no_cobro(codigo),
  causa_nombre       text,
  nota_conductor     text,
  -- entrega al regreso
  entregado_at       timestamptz,
  entregado_a        text,                                   -- quien recibe el dinero en la oficina
  entregado_firma    text,                                   -- firma (PNG en data URL)
  entregado_conductor text,                                  -- conductor que lo entrega
  liquidado_por      text,                                   -- usuario que lo registró
  anulado_motivo     text,
  constraint ck_cobro_cheque check (forma <> 'cheque' or (nullif(trim(coalesce(banco, '')), '') is not null and nullif(trim(coalesce(numero_cheque, '')), '') is not null))
);
create index if not exists cobros_ruta on public.cobros (ruta_id);
create index if not exists cobros_cliente on public.cobros (cliente_id);
create index if not exists cobros_estado on public.cobros (estado, created_at desc);
alter table public.cobros enable row level security;
revoke all on public.cobros from anon;
grant select, insert, update on public.cobros to authenticated;
insert into dgp_private.tabla_permisos (tabla, permisos) values ('cobros', array['cobros.gestionar'])
on conflict (tabla) do update set permisos = excluded.permisos;
drop policy if exists p_sel on public.cobros;
drop policy if exists p_ins on public.cobros;
drop policy if exists p_upd on public.cobros;
create policy p_sel on public.cobros for select to authenticated using (dgp_private.oficina() or dgp_private.ruta_propia(ruta_id));
create policy p_ins on public.cobros for insert to authenticated with check (dgp_private.escribe('cobros'));
create policy p_upd on public.cobros for update to authenticated using (dgp_private.escribe('cobros')) with check (dgp_private.escribe('cobros'));
drop trigger if exists tr_sin_html on public.cobros;
create trigger tr_sin_html before insert or update on public.cobros for each row execute function dgp_private.sin_html();

-- Guardia: altas siempre «pendiente»; la oficina solo edita cobros pendientes y solo anula pendientes / no recibidos.
-- Recibir, no recibir y entregar pasan por registrar_cobro / liquidar_cobros (marcan dgp.cobros = '1').
create or replace function dgp_private.guardia_cobros() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  if coalesce(current_setting('dgp.cobros', true), '') = '1' or auth.uid() is null then return new; end if;
  if tg_op = 'INSERT' then
    if new.estado <> 'pendiente' then raise exception 'Un cobro nuevo empieza como pendiente'; end if;
    if not exists (select 1 from rutas r where r.id = new.ruta_id and r.estado in ('simulada', 'aprobada', 'publicada', 'en_cargue', 'liberada', 'en_ruta')) then
      raise exception 'El viaje ya cerró: asigna el cobro a un viaje que no haya regresado';
    end if;
    new.creado_por := coalesce(dgp_private.nombre_usuario(), new.creado_por);
    new.conductor := null; new.gestion_at := null; new.monto_recibido := null; new.causa_codigo := null; new.causa_nombre := null;
    new.nota_conductor := null; new.entregado_at := null; new.entregado_a := null; new.entregado_firma := null; new.entregado_conductor := null; new.liquidado_por := null;
    return new;
  end if;
  if new.estado = 'anulado' and old.estado in ('pendiente', 'no_recibido') then
    if length(trim(coalesce(new.anulado_motivo, ''))) < 3 then raise exception 'Escribe el motivo de la anulación'; end if;
    if (to_jsonb(new) - array['estado', 'anulado_motivo', 'updated_at']) is distinct from (to_jsonb(old) - array['estado', 'anulado_motivo', 'updated_at']) then
      raise exception 'Al anular solo se cambia el estado y el motivo';
    end if;
    return new;
  end if;
  if old.estado <> 'pendiente' then raise exception 'El cobro ya fue gestionado por el conductor (%): no se edita', old.estado; end if;
  if new.estado <> 'pendiente' then raise exception 'El estado del cobro lo cambia el conductor o la liquidación al regreso'; end if;
  if (to_jsonb(new) - array['ruta_id', 'cliente_id', 'pedido_id', 'documento', 'monto', 'forma', 'banco', 'numero_cheque', 'notas', 'updated_at'])
     is distinct from (to_jsonb(old) - array['ruta_id', 'cliente_id', 'pedido_id', 'documento', 'monto', 'forma', 'banco', 'numero_cheque', 'notas', 'updated_at']) then
    raise exception 'Solo se editan los datos del cobro (viaje, cliente, documento, monto, forma, banco, cheque y notas)';
  end if;
  if new.ruta_id is distinct from old.ruta_id and not exists (select 1 from rutas r where r.id = new.ruta_id and r.estado in ('simulada', 'aprobada', 'publicada', 'en_cargue', 'liberada', 'en_ruta')) then
    raise exception 'El viaje elegido ya cerró';
  end if;
  return new;
end $$;
drop trigger if exists tr_guardia_cobros on public.cobros;
create trigger tr_guardia_cobros before insert or update on public.cobros for each row execute function dgp_private.guardia_cobros();

-- 4. Conductor: recibido / no recibido (corregible hasta que se entregue)
create or replace function public.registrar_cobro(cid uuid, recibido boolean, monto_recibido numeric default null, causa text default null,
                                                 nota text default null, lat double precision default null, lng double precision default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c record; r record; ca record; m numeric; causa_n text; quien text := coalesce(dgp_private.mi_nombre(), dgp_private.nombre_usuario(), 'sistema');
begin
  select * into c from cobros where id = cid for update;
  if not found then raise exception 'Cobro no encontrado'; end if;
  select * into r from rutas where id = c.ruta_id;
  if not (dgp_private.ruta_propia(c.ruta_id) or dgp_private.tiene('cobros.gestionar')) then raise exception 'Este cobro no es de tu viaje'; end if;
  if c.estado not in ('pendiente', 'recibido', 'no_recibido') then raise exception 'El cobro ya está %', c.estado; end if;
  if r.estado not in ('en_ruta', 'cerrada') then raise exception 'El viaje % aún no ha salido: registra el cobro cuando estés en ruta', r.codigo; end if;
  perform set_config('dgp.cobros', '1', true);
  if recibido then
    m := coalesce(monto_recibido, c.monto);
    if m <= 0 then raise exception 'El monto recibido debe ser mayor que cero'; end if;
    if m <> c.monto and length(trim(coalesce(nota, ''))) < 3 then raise exception 'El monto recibido (%) es distinto del monto a cobrar (%): explica la diferencia en la nota', m, c.monto; end if;
    update cobros set estado = 'recibido', conductor = coalesce(r.conductor, quien), gestion_at = now(), gestion_lat = lat, gestion_lng = lng,
           monto_recibido = m, causa_codigo = null, causa_nombre = null, nota_conductor = nullif(trim(coalesce(nota, '')), '') where id = cid;
  else
    select * into ca from causas_no_cobro where codigo = causa and activa;
    if not found then raise exception 'Elige la causa por la que no se recibió el pago'; end if;
    causa_n := ca.nombre;
    if ca.requiere_nota and length(trim(coalesce(nota, ''))) < 3 then raise exception 'La causa «%» requiere una nota', ca.nombre; end if;
    update cobros set estado = 'no_recibido', conductor = coalesce(r.conductor, quien), gestion_at = now(), gestion_lat = lat, gestion_lng = lng,
           monto_recibido = null, causa_codigo = ca.codigo, causa_nombre = ca.nombre, nota_conductor = nullif(trim(coalesce(nota, '')), '') where id = cid;
  end if;
  perform set_config('dgp.cobros', '', true);
  insert into auditoria (entidad, entidad_id, accion, detalle, actor, automatico) values ('cobros', cid,
    case when recibido then 'cobro_recibido' else 'cobro_no_recibido' end,
    format('%s · %s · B/. %s %s%s', r.codigo, (select nombre from clientes where id = c.cliente_id),
      to_char(case when recibido then m else c.monto end, 'FM999G999G990D00'), c.forma,
      case when recibido then '' else ' · causa: ' || causa_n end || coalesce(' · nota: ' || nullif(trim(coalesce(nota, '')), ''), '')),
    quien, false);
  return jsonb_build_object('ok', true, 'estado', case when recibido then 'recibido' else 'no_recibido' end);
end $$;
revoke all on function public.registrar_cobro(uuid, boolean, numeric, text, text, double precision, double precision) from public, anon;
grant execute on function public.registrar_cobro(uuid, boolean, numeric, text, text, double precision, double precision) to authenticated;

-- 5. Regreso: entrega del dinero con nombre y firma de quien lo recibe
create or replace function public.liquidar_cobros(ids uuid[], recibe text, firma text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare n int; malos text; tot numeric; quien text := coalesce(dgp_private.nombre_usuario(), 'sistema');
begin
  if not dgp_private.tiene('cobros.liquidar') then raise exception 'Recibir los cobros requiere el permiso «cobros.liquidar»'; end if;
  if coalesce(array_length(ids, 1), 0) = 0 then raise exception 'Elige los cobros que se entregan'; end if;
  if length(trim(coalesce(recibe, ''))) < 3 then raise exception 'Escribe el nombre de quien recibe el dinero'; end if;
  if firma is null or firma !~ '^data:image/png;base64,' or length(firma) < 1500 or length(firma) > 600000 then raise exception 'Falta la firma de quien recibe'; end if;
  select string_agg(coalesce(x.documento, x.id::text) || ' (' || x.estado || ')', ', ') into malos from cobros x where x.id = any(ids) and x.estado <> 'recibido';
  if malos is not null then raise exception 'Solo se entregan cobros recibidos por el conductor: %', malos; end if;
  perform set_config('dgp.cobros', '1', true);
  update cobros x set estado = 'entregado', entregado_at = now(), entregado_a = trim(recibe), entregado_firma = firma,
         entregado_conductor = x.conductor, liquidado_por = quien
   where x.id = any(ids) and x.estado = 'recibido';
  get diagnostics n = row_count;
  perform set_config('dgp.cobros', '', true);
  select sum(monto_recibido) into tot from cobros where id = any(ids);
  insert into auditoria (entidad, entidad_id, accion, detalle, actor, automatico)
  select 'cobros', x.id, 'cobro_entregado', format('%s · B/. %s %s%s · entrega %s · recibe %s', r.codigo, to_char(x.monto_recibido, 'FM999G999G990D00'), x.forma,
         case when x.forma = 'cheque' then ' ' || x.banco || ' nº ' || x.numero_cheque else '' end, coalesce(x.conductor, '—'), trim(recibe)), quien, false
    from cobros x join rutas r on r.id = x.ruta_id where x.id = any(ids);
  return jsonb_build_object('ok', true, 'entregados', n, 'total', tot);
end $$;
revoke all on function public.liquidar_cobros(uuid[], text, text) from public, anon;
grant execute on function public.liquidar_cobros(uuid[], text, text) to authenticated;
