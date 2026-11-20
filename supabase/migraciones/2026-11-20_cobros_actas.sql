-- DGP · Cobros (2/2): la firma de quien recibe el dinero va en un ACTA de entrega por viaje (cobros_liquidaciones),
-- no en cada cobro (la lista de cobros no carga imágenes). Aplicada como cobros_actas_20261120. Requiere 2026-11-20_cobros.sql.
create table if not exists public.cobros_liquidaciones (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  ruta_id        uuid not null references public.rutas(id),
  ruta_codigo    text,
  ruta_fecha     date,
  conductor      text,                 -- conductor que entrega el dinero
  recibe         text not null,        -- quien recibe en la oficina
  firma          text not null,        -- firma de quien recibe (PNG en data URL)
  liquidado_por  text not null,        -- usuario que lo registró
  n_cobros       integer not null,
  total          numeric(12,2) not null,
  total_efectivo numeric(12,2) not null default 0,
  total_cheques  numeric(12,2) not null default 0,
  n_cheques      integer not null default 0
);
create index if not exists cobros_liq_ruta on public.cobros_liquidaciones (ruta_id);
alter table public.cobros_liquidaciones enable row level security;
revoke all on public.cobros_liquidaciones from anon, authenticated;
grant select on public.cobros_liquidaciones to authenticated;
drop policy if exists p_sel on public.cobros_liquidaciones;
create policy p_sel on public.cobros_liquidaciones for select to authenticated using (dgp_private.oficina());

alter table public.cobros add column if not exists liquidacion_id uuid references public.cobros_liquidaciones(id);
alter table public.cobros drop column if exists entregado_firma;

-- guardia sin la columna de firma
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
    new.nota_conductor := null; new.entregado_at := null; new.entregado_a := null; new.liquidacion_id := null; new.entregado_conductor := null; new.liquidado_por := null;
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

create or replace function public.liquidar_cobros(ids uuid[], recibe text, firma text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare n int; malos text; rr record; lid uuid; quien text := coalesce(dgp_private.nombre_usuario(), 'sistema');
  t numeric; te numeric; tc numeric; nc int; cond text;
begin
  if not dgp_private.tiene('cobros.liquidar') then raise exception 'Recibir los cobros requiere el permiso «cobros.liquidar»'; end if;
  if coalesce(array_length(ids, 1), 0) = 0 then raise exception 'Elige los cobros que se entregan'; end if;
  if length(trim(coalesce(recibe, ''))) < 3 then raise exception 'Escribe el nombre de quien recibe el dinero'; end if;
  if firma is null or firma !~ '^data:image/png;base64,' or length(firma) < 1500 or length(firma) > 600000 then raise exception 'Falta la firma de quien recibe'; end if;
  perform 1 from cobros where id = any(ids) for update;
  select string_agg(coalesce(x.documento, x.id::text) || ' (' || x.estado || ')', ', ') into malos from cobros x where x.id = any(ids) and x.estado <> 'recibido';
  if malos is not null then raise exception 'Solo se entregan cobros recibidos por el conductor: %', malos; end if;
  if (select count(distinct ruta_id) from cobros where id = any(ids)) <> 1 then raise exception 'El acta es por viaje: elige cobros de un solo viaje'; end if;
  select r.* into rr from rutas r where r.id = (select ruta_id from cobros where id = ids[1]);
  select sum(monto_recibido), coalesce(sum(monto_recibido) filter (where forma = 'efectivo'), 0), coalesce(sum(monto_recibido) filter (where forma = 'cheque'), 0),
         count(*) filter (where forma = 'cheque'), string_agg(distinct conductor, ', ')
    into t, te, tc, nc, cond from cobros where id = any(ids);
  insert into cobros_liquidaciones (ruta_id, ruta_codigo, ruta_fecha, conductor, recibe, firma, liquidado_por, n_cobros, total, total_efectivo, total_cheques, n_cheques)
  values (rr.id, rr.codigo, rr.fecha, coalesce(cond, rr.conductor), trim(recibe), firma, quien, array_length(ids, 1), t, te, tc, nc) returning id into lid;
  perform set_config('dgp.cobros', '1', true);
  update cobros x set estado = 'entregado', entregado_at = now(), entregado_a = trim(recibe), entregado_conductor = x.conductor,
         liquidado_por = quien, liquidacion_id = lid
   where x.id = any(ids) and x.estado = 'recibido';
  get diagnostics n = row_count;
  perform set_config('dgp.cobros', '', true);
  insert into auditoria (entidad, entidad_id, accion, detalle, actor, automatico)
  values ('cobros_liquidaciones', lid, 'cobros_entregados', format('%s (%s) · %s cobros · B/. %s (efectivo %s · %s cheques %s) · entrega %s · recibe %s',
          rr.codigo, rr.fecha, n, to_char(t, 'FM999G999G990D00'), to_char(te, 'FM999G999G990D00'), nc, to_char(tc, 'FM999G999G990D00'), coalesce(cond, '—'), trim(recibe)), quien, false);
  return jsonb_build_object('ok', true, 'acta', lid, 'entregados', n, 'total', t, 'efectivo', te, 'cheques', tc, 'n_cheques', nc);
end $$;
revoke all on function public.liquidar_cobros(uuid[], text, text) from public, anon;
grant execute on function public.liquidar_cobros(uuid[], text, text) to authenticated;
