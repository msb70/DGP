-- DGP · Rutas preestablecidas de Zoho Books + direcciones de entrega por orden (16-nov-2026)
-- Idempotente. Ejecutar en el SQL Editor de Supabase (también está al final de v3_produccion.sql).
--
-- 1) Las 9 rutas fijas de DGP (campo personalizado «Rutas» de la orden de venta) se guardan en `zonas`, que es lo que usa
--    el motor de planificación para agrupar. Cada ruta tiene sus días de salida y su tipo (entrega | retiro en bodega).
-- 2) Un cliente puede tener varias direcciones: cada dirección de envío que llega en una orden se guarda en
--    `cliente_direcciones` (una fila por dirección distinta) y se geocodifica una sola vez.
-- OJO: si se vuelve a ejecutar migraciones/2026-10-10_hermes_10c.sql, volver a ejecutar esta después (redefine zoho_guardar_pedido).
-- 3) El pedido guarda su ruta (zona_codigo + texto original de Zoho) y su dirección de entrega con las coordenadas.

-- ---------------------------------------------------------------------
-- 1. Rutas preestablecidas
-- ---------------------------------------------------------------------
alter table zonas add column if not exists dias int[];                    -- ISO: 1 = lunes … 7 = domingo; null = cualquier día
alter table zonas add column if not exists tipo text default 'entrega';   -- entrega | retiro (el cliente retira en bodega: no va en camión)
alter table zonas add column if not exists zoho_valor text;               -- último texto recibido de Zoho para esta ruta
alter table zonas add column if not exists orden int;
alter table zonas add column if not exists activa boolean default true;
alter table zonas drop constraint if exists ck_zonas_tipo;
alter table zonas add constraint ck_zonas_tipo check (tipo in ('entrega', 'retiro'));

-- Colores = los de las etiquetas del campo «Rutas» en Zoho Books (rojo, verde, marrón, morado, rosado, amarillo, azul, gris, negro).
-- «do nothing»: si después se editan colores o días desde la plataforma, volver a ejecutar no los pisa.
insert into zonas (codigo, nombre, color, prioridad, dias, tipo, zoho_valor, orden, activa) values
 ('R1', 'Ruta 1 · Panamá Centro, Ancón, Dorado, San Francisco, Río Abajo', '#E53935', 3, '{1,2,3}',       'entrega', 'Ruta 1 Lunes a Miércoles Panamá Centro Ancón Dorado San Francisco Rio abajo', 1, true),
 ('R2', 'Ruta 2 · Panamá Este (Costa del Este, Tocumen, Pacora, Darién, Chepo)', '#16A34A', 3, '{3}',     'entrega', 'Ruta 2 Miércoles Panamá Este (Costa del este Tocumen Pacora Darién Chepo)', 2, true),
 ('R3', 'Ruta 3 · Panamá Norte, San Miguelito, Colón', '#8B4513', 3, '{4}',                                'entrega', 'Ruta3 Jueves Panama Norte San Miguelito -Colon', 3, true),
 ('R4', 'Ruta 4 · Chorrera, Arraiján', '#A855F7', 3, '{4}',                                                'entrega', 'Ruta 4 Jueves Chorrera Arraijan', 4, true),
 ('R5', 'Ruta 5 · Capira', '#F472B6', 3, '{4}',                                                            'entrega', 'Ruta 5 Jueves Capira', 5, true),
 ('R6', 'Ruta 6 · Interior (Chitré, Las Tablas, Valle, Santiago)', '#FDE047', 3, '{4,5}',                  'entrega', 'Ruta 6 Jueves- Viernes interior Chitré Las Tablas Valle Santiago', 6, true),
 ('R7', 'Ruta 7 · Playas', '#2563EB', 3, null,                                                             'entrega', 'Ruta 7 Playas', 7, true),
 ('R8', 'Ruta 8 · Penonomé, Antón, Río Hato', '#6B7280', 3, '{5}',                                         'entrega', 'Ruta 8 Viernes Penonomé Antón Rio Hato', 8, true),
 ('R9', 'Ruta 9 · Mates / Encomiendas (retiro en bodega)', '#111111', 3, '{1,2,3,4,5,6,7}',                'retiro',  'Ruta 9 Mates Encomiendas- Todos los días Retiro Bodega', 9, true)
on conflict (codigo) do nothing;
-- Zonas de la demo de octubre: quedan inactivas (no se borran).
update zonas set activa = false where codigo in ('CENTRO', 'ESTE', 'NORTE', 'OESTE') and activa is distinct from false;

-- ---------------------------------------------------------------------
-- 2. Direcciones de entrega por cliente
-- ---------------------------------------------------------------------
create table if not exists cliente_direcciones (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references clientes(id) on delete cascade,
  clave text not null,                         -- 'z:<address_id de Zoho>' o 't:<texto normalizado>' (identifica la dirección)
  zoho_address_id text,
  atencion text,                               -- «Atención» de la dirección de envío (local, sucursal o persona)
  direccion text not null,
  telefono text,
  lat double precision, lng double precision,
  geo_estado text default 'pendiente',         -- pendiente | automatica | aproximada | no_encontrada | validada | dudosa
  geo_fuente text, geo_detalle text, geo_at timestamptz,
  pedidos int default 0, ultimo_pedido_at timestamptz,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  unique (cliente_id, clave)
);
create index if not exists ix_cli_dir_cliente on cliente_direcciones(cliente_id);
create index if not exists ix_cli_dir_geo_pend on cliente_direcciones(created_at) where lat is null;

alter table cliente_direcciones enable row level security;
alter table cliente_direcciones force row level security;
revoke all on cliente_direcciones from anon;
drop policy if exists p_sel on cliente_direcciones;
drop policy if exists p_ins on cliente_direcciones;
drop policy if exists p_upd on cliente_direcciones;
drop policy if exists p_del on cliente_direcciones;
-- Mismos permisos que el maestro de clientes (corregir coordenadas a mano = catalogo.editar)
create policy p_sel on cliente_direcciones for select to authenticated using (dgp_private.perfil_activo());
create policy p_ins on cliente_direcciones for insert to authenticated with check (dgp_private.escribe('clientes'));
create policy p_upd on cliente_direcciones for update to authenticated using (dgp_private.escribe('clientes')) with check (dgp_private.escribe('clientes'));
create policy p_del on cliente_direcciones for delete to authenticated using (dgp_private.escribe('clientes') and dgp_private.tiene('catalogo.editar'));
grant select, insert, update, delete on cliente_direcciones to authenticated;

-- ---------------------------------------------------------------------
-- 3. Ruta y dirección en el pedido
-- ---------------------------------------------------------------------
alter table pedidos add column if not exists zona_codigo text;
alter table pedidos add column if not exists ruta_zoho text;               -- texto tal cual llegó en el campo «Rutas» de Zoho
alter table pedidos add column if not exists direccion_id uuid;
alter table pedidos add column if not exists direccion_entrega text;
alter table pedidos add column if not exists entrega_lat double precision;
alter table pedidos add column if not exists entrega_lng double precision;
alter table pedidos add column if not exists entrega_geo_estado text;
alter table pedidos drop constraint if exists pedidos_zona_fk;
alter table pedidos add constraint pedidos_zona_fk foreign key (zona_codigo) references zonas(codigo) on update cascade on delete set null;
alter table pedidos drop constraint if exists pedidos_direccion_fk;
alter table pedidos add constraint pedidos_direccion_fk foreign key (direccion_id) references cliente_direcciones(id) on delete set null;
create index if not exists ix_pedidos_direccion on pedidos(direccion_id) where direccion_id is not null;

-- Cuando una dirección se geocodifica (o se corrige a mano), los pedidos abiertos que van a ella toman la coordenada.
create or replace function dgp_private.propagar_direccion() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update pedidos set direccion_entrega = new.direccion, entrega_lat = new.lat, entrega_lng = new.lng, entrega_geo_estado = new.geo_estado, updated_at = now()
   where direccion_id = new.id and estado in ('pendiente_validar', 'elegible', 'en_excepcion', 'diferido')
     and (entrega_lat is distinct from new.lat or entrega_lng is distinct from new.lng or entrega_geo_estado is distinct from new.geo_estado or direccion_entrega is distinct from new.direccion);
  return new;
end $$;
drop trigger if exists tr_propagar_direccion on cliente_direcciones;
create trigger tr_propagar_direccion after update of lat, lng, geo_estado, direccion on cliente_direcciones
  for each row execute function dgp_private.propagar_direccion();

-- Alta / actualización de una dirección de entrega recibida en una orden de Zoho (solo la Edge Function "zoho").
-- Si el texto de una dirección conocida cambió en Zoho, se reinicia su geocodificación.
drop function if exists public.zoho_guardar_direccion(uuid, jsonb);
create or replace function public.zoho_guardar_direccion(cliente uuid, d jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r cliente_direcciones;
begin
  if coalesce(trim(d->>'direccion'), '') = '' or coalesce(d->>'clave', '') = '' then raise exception 'Dirección vacía' using errcode = '22023'; end if;
  insert into cliente_direcciones as x (cliente_id, clave, zoho_address_id, atencion, direccion, telefono, pedidos, ultimo_pedido_at)
  values (cliente, d->>'clave', nullif(d->>'zoho_address_id', ''), nullif(d->>'atencion', ''), d->>'direccion', nullif(d->>'telefono', ''), 1, now())
  on conflict (cliente_id, clave) do update set
    atencion = coalesce(excluded.atencion, x.atencion), telefono = coalesce(excluded.telefono, x.telefono),
    direccion = excluded.direccion, ultimo_pedido_at = now(), updated_at = now(),
    lat = case when x.direccion is distinct from excluded.direccion and x.geo_estado <> 'validada' then null else x.lat end,
    lng = case when x.direccion is distinct from excluded.direccion and x.geo_estado <> 'validada' then null else x.lng end,
    geo_estado = case when x.direccion is distinct from excluded.direccion and x.geo_estado <> 'validada' then 'pendiente' else x.geo_estado end
  returning * into r;
  -- el cliente sin dirección principal toma la primera de entrega conocida
  update clientes set direccion = r.direccion, updated_at = now() where id = cliente and direccion is null;
  return to_jsonb(r) || jsonb_build_object('nueva', r.created_at = r.updated_at);
end $$;
revoke execute on function public.zoho_guardar_direccion(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.zoho_guardar_direccion(uuid, jsonb) to service_role;

-- Cuenta cuántas órdenes distintas usan cada dirección (se recalcula al guardar el pedido).
create or replace function dgp_private.contar_pedidos_direccion(did uuid) returns void
language sql security definer set search_path = public, pg_temp as $$
  update cliente_direcciones set pedidos = (select count(*) from pedidos where direccion_id = did) where id = did $$;

-- ZOH-001 ampliado: cabecera (con ruta y dirección de entrega) + líneas en una transacción.
create or replace function public.zoho_guardar_pedido(pedido jsonb, lineas jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare ex pedidos; r pedidos; pid uuid; nuevo boolean; dir cliente_direcciones;
begin
  if jsonb_typeof(lineas) <> 'array' or jsonb_array_length(lineas) = 0 then raise exception 'La orden % no tiene líneas', pedido->>'numero_so' using errcode = '22023'; end if;
  r := jsonb_populate_record(null::pedidos, pedido);
  if r.zona_codigo is not null and not exists (select 1 from zonas where codigo = r.zona_codigo) then r.zona_codigo := null; end if;
  if r.direccion_id is not null then select * into dir from cliente_direcciones where id = r.direccion_id and cliente_id = r.cliente_id; if not found then r.direccion_id := null; end if; end if;
  select * into ex from pedidos where zoho_salesorder_id = r.zoho_salesorder_id for update;
  nuevo := not found;
  if nuevo then
    insert into pedidos (zoho_salesorder_id, numero_so, cliente_id, fecha, valor, peso_kg, volumen_m3, cajas, numero_factura, zoho_invoice_id, zoho_customer_id, origen, estado,
                         zona_codigo, ruta_zoho, direccion_id, direccion_entrega, entrega_lat, entrega_lng, entrega_geo_estado)
    values (r.zoho_salesorder_id, r.numero_so, r.cliente_id, r.fecha, r.valor, r.peso_kg, r.volumen_m3, r.cajas, r.numero_factura, r.zoho_invoice_id, r.zoho_customer_id, r.origen, 'pendiente_validar',
            r.zona_codigo, r.ruta_zoho, r.direccion_id, coalesce(dir.direccion, r.direccion_entrega), dir.lat, dir.lng, dir.geo_estado)
    returning id into pid;
  else
    pid := ex.id;
    update pedidos set numero_so = r.numero_so, cliente_id = r.cliente_id, fecha = r.fecha, valor = r.valor, peso_kg = r.peso_kg, volumen_m3 = r.volumen_m3,
           cajas = r.cajas, numero_factura = r.numero_factura, zoho_invoice_id = r.zoho_invoice_id, zoho_customer_id = r.zoho_customer_id, origen = r.origen,
           zona_codigo = r.zona_codigo, ruta_zoho = r.ruta_zoho, direccion_id = r.direccion_id, direccion_entrega = coalesce(dir.direccion, r.direccion_entrega),
           entrega_lat = dir.lat, entrega_lng = dir.lng, entrega_geo_estado = dir.geo_estado, updated_at = now()
     where id = pid;
    delete from pedido_lineas where pedido_id = pid;
    if ex.direccion_id is not null and ex.direccion_id is distinct from r.direccion_id then perform dgp_private.contar_pedidos_direccion(ex.direccion_id); end if;
  end if;
  insert into pedido_lineas (pedido_id, sku, cantidad_cajas, precio, zoho_line_item_id)
  select pid, x.sku, x.cantidad_cajas, x.precio, x.zoho_line_item_id from jsonb_populate_recordset(null::pedido_lineas, lineas) x;
  if r.direccion_id is not null then perform dgp_private.contar_pedidos_direccion(r.direccion_id); end if;
  return jsonb_build_object('id', pid, 'nuevo', nuevo, 'lineas', jsonb_array_length(lineas));
end $$;
revoke execute on function public.zoho_guardar_pedido(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.zoho_guardar_pedido(jsonb, jsonb) to service_role;

-- Regla de planificación: cada ruta preestablecida solo se planifica sus días de salida (se puede apagar desde Reglas).
insert into reglas (clave, valor, descripcion, accion)
values ('rutas_por_dia', '{"activo": true}', 'Planificar cada ruta preestablecida solo los días en que sale (Ruta 1 lunes–miércoles, Ruta 2 miércoles…). Los pedidos de rutas que no salen hoy quedan diferidos.', 'planificacion')
on conflict (clave) do nothing;

