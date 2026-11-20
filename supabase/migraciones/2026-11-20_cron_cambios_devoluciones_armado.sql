-- DGP · 20-nov-2026 (noche). Idempotente. Aplicada como cron_cambios_devoluciones_armado_20261120.
-- A1  Sincronización automática de órdenes de Zoho (pg_cron + pg_net → función zoho, acción cron_pedidos, por tramos).
-- F1  Cambio de producto en la verificación («este por este»), con aviso y aplicación por Facturación.
-- F2  Devoluciones de venta en Zoho Inventory creadas desde la recepción del camión (sin recibir ni nota de crédito).
-- I1  Armado del manifiesto por camión: auxiliar de bodega responsable y avance por SKU.
-- C5  Rótulo de ruta: «Ruta 1 · viaje 1/6» → «Ruta 1 · Camión 1 de 6 · placa (descripción)».

-- ===== A1 =====
create table if not exists dgp_private.zoho_cron (
  id            int primary key default 1 check (id = 1),
  cron_secret   text not null default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  dispatch_url  text not null,
  apikey        text not null,             -- clave pública (anon) del proyecto: pasa la verificación JWT de la función
  activo        boolean not null default true,
  ultimo_lanzado timestamptz
);
-- (la fila se inserta aparte con la URL y la clave pública, sin repetir el secreto en el repositorio)

create or replace function public.zoho_cron_valido(t text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from dgp_private.zoho_cron where id = 1 and activo and cron_secret = t) $$;
revoke all on function public.zoho_cron_valido(text) from public, anon, authenticated;
grant execute on function public.zoho_cron_valido(text) to service_role;

create or replace function dgp_private.zoho_cron_lanzar(pagina int default 1) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare z record;
begin
  select * into z from dgp_private.zoho_cron where id = 1 and activo;
  if not found then return; end if;
  if not exists (select 1 from integraciones where sistema in ('zoho_books', 'zoho_inventory') and activo) then return; end if;
  perform net.http_post(url := z.dispatch_url,
    body := jsonb_build_object('accion', 'cron_pedidos', 'pagina', greatest(1, pagina)),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-dgp-cron', z.cron_secret, 'Authorization', 'Bearer ' || z.apikey, 'apikey', z.apikey),
    timeout_milliseconds := 5000);
  update dgp_private.zoho_cron set ultimo_lanzado = now() where id = 1;
end $$;

-- la función zoho pide el siguiente tramo al terminar uno (sin depender de que la pantalla esté abierta)
create or replace function public.zoho_cron_siguiente(t text, pagina int) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.zoho_cron_valido(t) then return false; end if;
  if pagina is null or pagina < 2 or pagina > 200 then return false; end if;
  perform dgp_private.zoho_cron_lanzar(pagina);
  return true;
end $$;
revoke all on function public.zoho_cron_siguiente(text, int) from public, anon, authenticated;
grant execute on function public.zoho_cron_siguiente(text, int) to service_role;

do $$ begin
  perform cron.unschedule(jobid) from cron.job where jobname in ('dgp-zoho-pedidos-madrugada', 'dgp-zoho-pedidos-mediodia');
  perform cron.schedule('dgp-zoho-pedidos-madrugada', '30 10 * * *', 'select dgp_private.zoho_cron_lanzar(1)');   -- 05:30 Panamá
  perform cron.schedule('dgp-zoho-pedidos-mediodia',  '0 17 * * 1-6', 'select dgp_private.zoho_cron_lanzar(1)');  -- 12:00 Panamá, lun–sáb
end $$;

-- ===== F1 =====
insert into public.permisos (codigo, modulo, nombre, orden) values
  ('cambios.facturar', 'Operación', 'Aplicar en la factura los cambios de producto de la verificación', 44)
on conflict (codigo) do nothing;
insert into public.rol_permisos (rol, permiso)
select x.rol, 'cambios.facturar' from (values ('admin'), ('facturacion')) x(rol)
where exists (select 1 from public.roles r where r.codigo = x.rol)
  and not exists (select 1 from public.rol_permisos rp where rp.rol = x.rol and rp.permiso = 'cambios.facturar');

create table if not exists public.cambios_producto (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  ruta_id            uuid references public.rutas(id),
  paquete_id         uuid references public.paquetes(id),
  pedido_id          uuid not null references public.pedidos(id),
  factura            text,
  cliente_id         uuid references public.clientes(id),
  sku_original       text not null,
  articulo_original  text,
  sku_sustituto      text not null,
  articulo_sustituto text,
  cantidad           numeric not null check (cantidad > 0),
  motivo             text not null check (length(trim(motivo)) >= 3),
  registrado_por     text,
  estado             text not null default 'pendiente' check (estado in ('pendiente', 'aplicado', 'rechazado')),
  resuelto_por       text,
  resuelto_at        timestamptz,
  nota_facturacion   text,
  check (sku_original <> sku_sustituto)
);
create index if not exists cambios_producto_ruta on public.cambios_producto (ruta_id);
create index if not exists cambios_producto_estado on public.cambios_producto (estado, created_at desc);
alter table public.cambios_producto enable row level security;
revoke all on public.cambios_producto from anon;
grant select, insert on public.cambios_producto to authenticated;
insert into dgp_private.tabla_permisos (tabla, permisos) values ('cambios_producto', array['verificar']) on conflict (tabla) do update set permisos = excluded.permisos;
drop policy if exists p_sel on public.cambios_producto;
drop policy if exists p_ins on public.cambios_producto;
create policy p_sel on public.cambios_producto for select to authenticated using (dgp_private.oficina());
create policy p_ins on public.cambios_producto for insert to authenticated with check (dgp_private.escribe('cambios_producto') and estado = 'pendiente');
drop trigger if exists tr_sin_html on public.cambios_producto;
create trigger tr_sin_html before insert or update on public.cambios_producto for each row execute function dgp_private.sin_html();

create or replace function public.resolver_cambio_producto(cid uuid, aplicado boolean, nota text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c record; quien text := coalesce(dgp_private.nombre_usuario(), 'sistema');
begin
  if not dgp_private.tiene('cambios.facturar') then raise exception 'Aplicar cambios de producto requiere el permiso «cambios.facturar»'; end if;
  select * into c from cambios_producto where id = cid for update;
  if not found then raise exception 'Cambio no encontrado'; end if;
  if c.estado <> 'pendiente' then raise exception 'El cambio ya está %', c.estado; end if;
  if not aplicado and length(trim(coalesce(nota, ''))) < 3 then raise exception 'Explica por qué se rechaza el cambio'; end if;
  update cambios_producto set estado = case when aplicado then 'aplicado' else 'rechazado' end, resuelto_por = quien, resuelto_at = now(), nota_facturacion = nullif(trim(coalesce(nota, '')), '') where id = cid;
  insert into auditoria (entidad, entidad_id, accion, detalle, actor, automatico) values ('cambios_producto', cid, case when aplicado then 'cambio_aplicado' else 'cambio_rechazado' end,
    format('%s: %s → %s × %s%s', coalesce(c.factura, ''), c.sku_original, c.sku_sustituto, c.cantidad, coalesce(' · ' || nullif(trim(coalesce(nota, '')), ''), '')), quien, false);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.resolver_cambio_producto(uuid, boolean, text) from public, anon;
grant execute on function public.resolver_cambio_producto(uuid, boolean, text) to authenticated;

-- ===== F2 =====
create table if not exists public.devoluciones_zoho (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  recepcion_id        uuid not null references public.recepciones(id),
  pedido_id           uuid references public.pedidos(id),
  factura             text,
  lineas              jsonb not null default '[]'::jsonb,   -- [{sku, cantidad}]
  estado              text not null default 'pendiente' check (estado in ('pendiente', 'creada', 'error')),
  zoho_salesreturn_id text,
  zoho_numero         text,
  error               text,
  creado_por          text,
  unique (recepcion_id, pedido_id)
);
alter table public.devoluciones_zoho enable row level security;
revoke all on public.devoluciones_zoho from anon, authenticated;
grant select on public.devoluciones_zoho to authenticated;
drop policy if exists p_sel on public.devoluciones_zoho;
create policy p_sel on public.devoluciones_zoho for select to authenticated using (dgp_private.oficina());

-- ===== I1 =====
create table if not exists public.armados (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  fecha         date not null,
  vehiculo_id   uuid not null references public.vehiculos(id),
  armador       text not null,
  asignado_por  text,
  estado        text not null default 'asignado' check (estado in ('asignado', 'en_proceso', 'terminado')),
  inicio_at     timestamptz,
  fin_at        timestamptz,
  sacado        jsonb not null default '{}'::jsonb,   -- { sku: unidades sacadas }
  nota          text,
  unique (fecha, vehiculo_id)
);
alter table public.armados enable row level security;
revoke all on public.armados from anon;
grant select, insert, update on public.armados to authenticated;
insert into dgp_private.tabla_permisos (tabla, permisos) values ('armados', array['manifiesto.cargar', 'planificar']) on conflict (tabla) do update set permisos = excluded.permisos;
drop policy if exists p_sel on public.armados;
drop policy if exists p_ins on public.armados;
drop policy if exists p_upd on public.armados;
create policy p_sel on public.armados for select to authenticated using (dgp_private.oficina());
create policy p_ins on public.armados for insert to authenticated with check (dgp_private.escribe('armados'));
create policy p_upd on public.armados for update to authenticated using (dgp_private.escribe('armados')) with check (dgp_private.escribe('armados'));
drop trigger if exists tr_sin_html on public.armados;
create trigger tr_sin_html before insert or update on public.armados for each row execute function dgp_private.sin_html();

-- ===== C5 =====
update public.rutas r set color_nombre = regexp_replace(r.color_nombre, ' · viaje (\d+)/(\d+)$',
       ' · Camión \1 de \2 · ' || coalesce(v.placa, '') || coalesce(' (' || nullif(v.nombre, '') || ')', ''))
  from public.vehiculos v where v.id = r.vehiculo_id and r.color_nombre ~ ' · viaje \d+/\d+$';
update public.paquetes q set color_nombre = r.color_nombre from public.rutas r
 where r.id = q.ruta_id and q.color_nombre ~ ' · viaje \d+/\d+$';

-- ===== zoho_cron_pasos_20261120: cadena clientes → artículos → pedidos =====
create or replace function public.zoho_cron_valido(t text) returns boolean
 language sql stable security definer set search_path to 'public', 'pg_temp' as $function$
  select exists (select 1 from dgp_private.zoho_cron where id = 1 and activo and cron_secret = t) $function$;

create or replace function dgp_private.zoho_cron_lanzar(pagina integer default 1, paso text default 'clientes') returns void
 language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare z record;
begin
  select * into z from dgp_private.zoho_cron where id = 1 and activo;
  if not found then return; end if;
  if not exists (select 1 from integraciones where sistema in ('zoho_books', 'zoho_inventory') and activo) then return; end if;
  if paso not in ('clientes', 'articulos', 'pedidos') then return; end if;
  perform net.http_post(url := z.dispatch_url,
    body := jsonb_build_object('accion', 'cron_pedidos', 'paso', paso, 'pagina', greatest(1, pagina)),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-dgp-cron', z.cron_secret, 'Authorization', 'Bearer ' || z.apikey, 'apikey', z.apikey),
    timeout_milliseconds := 5000);
  update dgp_private.zoho_cron set ultimo_lanzado = now() where id = 1;
end $function$;

create or replace function public.zoho_cron_siguiente(t text, paso text, pagina integer) returns boolean
 language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
begin
  if not public.zoho_cron_valido(t) then return false; end if;
  if pagina is null or pagina < 1 or pagina > 200 or paso not in ('clientes', 'articulos', 'pedidos') then return false; end if;
  perform dgp_private.zoho_cron_lanzar(pagina, paso);
  return true;
end $function$;
revoke all on function public.zoho_cron_valido(text), public.zoho_cron_siguiente(text, text, integer) from public, anon, authenticated;
grant execute on function public.zoho_cron_valido(text), public.zoho_cron_siguiente(text, text, integer) to service_role;
