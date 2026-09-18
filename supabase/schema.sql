-- =====================================================================
-- DGP · Torre de Control Logística — MVP
-- Esquema para Supabase (plan Free) · Postgres 15/17 · sin extensiones de pago
-- Pegar completo en SQL Editor → Run. Idempotente (se puede volver a ejecutar).
-- ATENCIÓN: las políticas RLS de este archivo permiten acceso total con la
-- clave anon. Es deliberado para la DEMO. En producción se sustituyen por
-- políticas por rol (ver propuesta técnica, sección 16).
-- =====================================================================
create extension if not exists pgcrypto;

create table if not exists bodegas (
  id uuid primary key default gen_random_uuid(),
  codigo text unique not null, nombre text not null, direccion text,
  lat double precision, lng double precision, hora_corte text default '15:00'
);
create table if not exists zonas (
  id uuid primary key default gen_random_uuid(),
  codigo text unique not null, nombre text not null, color text, prioridad int default 3
);
create table if not exists clientes (
  id uuid primary key default gen_random_uuid(),
  codigo text unique not null, nombre text not null, zona_codigo text references zonas(codigo),
  direccion text, lat double precision, lng double precision,
  geo_estado text default 'pendiente',          -- pendiente|automatica|validada|dudosa|aproximada
  ventana_inicio text, ventana_fin text, tiempo_servicio_min int default 15,
  contacto text, telefono text, ejecutivo text,
  credito_bloqueado boolean default false, zoho_account_id text,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create table if not exists articulos (
  id uuid primary key default gen_random_uuid(),
  sku text unique not null, nombre text not null, categoria text, precio numeric(10,2),
  peso_kg numeric(10,3), volumen_m3 numeric(10,4), unidades_por_caja int, fragil boolean default false,
  ubicacion text, codigo_barras text, zoho_item_id text
);
create table if not exists vehiculos (
  id uuid primary key default gen_random_uuid(),
  placa text unique not null, nombre text, tipo text,
  cap_valor numeric(12,2) default 2500, cap_peso_kg numeric(10,2), cap_volumen_m3 numeric(10,3), cap_cajas int, cap_posiciones int,
  km_por_litro numeric(6,2), panapass_tag text, conductor text, ayudante text, color text, costo_km numeric(8,3),
  odometro_km numeric(12,1), activo boolean default true
);
create table if not exists personas (
  id uuid primary key default gen_random_uuid(),
  nombre text not null, rol text not null, telefono text, pin text, activo boolean default true,
  unique (nombre, rol)
);
create table if not exists reglas (
  id uuid primary key default gen_random_uuid(),
  clave text unique not null, valor jsonb not null, descripcion text, accion text,
  actualizado_por text, updated_at timestamptz default now()
);
create table if not exists pedidos (
  id uuid primary key default gen_random_uuid(),
  numero_so text unique not null, numero_factura text, cliente_id uuid references clientes(id),
  fecha date default current_date, prioridad int default 3,
  valor numeric(12,2) not null, peso_kg numeric(10,2), volumen_m3 numeric(10,4), cajas int,
  estado text default 'pendiente_validar',   -- pendiente_validar|elegible|en_excepcion|planificado|pendiente_autorizacion|diferido|entregado|parcial|no_entregado|cancelado
  causa text, grupo text, ruta_id uuid, secuencia int, zoho_salesorder_id text,
  autorizado_por text, created_at timestamptz default now(), updated_at timestamptz default now()
);
create table if not exists pedido_lineas (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid references pedidos(id) on delete cascade, sku text references articulos(sku),
  cantidad_cajas int not null, precio numeric(10,2), entregado int
);
create table if not exists rutas (
  id uuid primary key default gen_random_uuid(),
  codigo text not null, fecha date default current_date, vehiculo_id uuid references vehiculos(id),
  conductor text, ayudante text, zona_codigo text,
  estado text default 'simulada',  -- simulada|aprobada|publicada|en_cargue|liberada|en_ruta|cerrada|conciliada
  version int default 1, valor numeric(12,2) default 0, peso_kg numeric(10,2) default 0, volumen_m3 numeric(10,4) default 0, cajas int default 0, posiciones numeric(6,1) default 0,
  km_plan numeric(8,1), km_real numeric(8,1), hora_salida text, hora_fin_prevista text, limite text,
  geometria jsonb,                 -- polilínea OSRM [[lat,lng],...]
  salida_at timestamptz, llegada_at timestamptz, odometro_salida numeric(12,1), odometro_llegada numeric(12,1),
  created_at timestamptz default now(), updated_at timestamptz default now()
);
alter table pedidos drop constraint if exists pedidos_ruta_fk;
alter table pedidos add constraint pedidos_ruta_fk foreign key (ruta_id) references rutas(id) on delete set null;
create table if not exists paradas (
  id uuid primary key default gen_random_uuid(),
  ruta_id uuid references rutas(id) on delete cascade, secuencia int not null,
  tipo text default 'entrega',     -- entrega|compra|almuerzo|recogida|combustible
  pedido_id uuid references pedidos(id), cliente_id uuid references clientes(id),
  lat double precision, lng double precision, eta text, ventana_inicio text, ventana_fin text, duracion_min int, km_tramo numeric(8,2),
  estado text default 'pendiente', -- pendiente|en_sitio|atendida|parcial|no_entregada|reprogramada
  resultado text, receptor text, firma text, foto text, notas text,
  checkin_at timestamptz, checkout_at timestamptz, checkin_lat double precision, checkin_lng double precision, distancia_checkin_m numeric(8,1)
);
create table if not exists manifiestos (
  id uuid primary key default gen_random_uuid(),
  ruta_id uuid unique references rutas(id) on delete cascade, numero text, estado text default 'pendiente',
  preparador text, cargador text, verificador text, inicio_cargue timestamptz, fin_cargue timestamptz
);
create table if not exists manifiesto_lineas (
  id uuid primary key default gen_random_uuid(),
  manifiesto_id uuid references manifiestos(id) on delete cascade, sku text, ubicacion text, requerido int, cargado int default 0
);
create table if not exists eventos (
  id uuid primary key default gen_random_uuid(),
  ruta_id uuid references rutas(id) on delete cascade, parada_id uuid references paradas(id) on delete cascade,
  tipo text not null, detalle jsonb, lat double precision, lng double precision,
  ts_dispositivo timestamptz, offline boolean default false, actor text, created_at timestamptz default now()
);
create table if not exists incidencias (
  id uuid primary key default gen_random_uuid(),
  ruta_id uuid references rutas(id) on delete cascade, parada_id uuid, tipo text, descripcion text, demora_min int,
  estado text default 'registrada', actor text, created_at timestamptz default now(), cerrada_at timestamptz
);
create table if not exists alertas (
  id uuid primary key default gen_random_uuid(),
  tipo text, severidad text default 'media', titulo text, detalle text, entidad text, destinatario text,
  leida boolean default false, cerrada boolean default false, created_at timestamptz default now()
);
create table if not exists auditoria (
  id bigint generated always as identity primary key,
  entidad text, entidad_id text, accion text, detalle text, valor_anterior jsonb, valor_nuevo jsonb,
  actor text, automatico boolean default false, created_at timestamptz default now()
);
create table if not exists abastecimientos (
  id uuid primary key default gen_random_uuid(),
  ruta_id uuid references rutas(id) on delete cascade, vehiculo_id uuid references vehiculos(id), fecha timestamptz default now(),
  estacion text, litros numeric(8,2), costo numeric(10,2), odometro_km numeric(12,1), foto text
);
create table if not exists peajes (
  id uuid primary key default gen_random_uuid(),
  ruta_id uuid references rutas(id) on delete cascade, punto text, monto_estimado numeric(8,2), monto_real numeric(8,2),
  fuente text default 'estimado', fuera_de_ruta boolean default false, conciliado boolean default false
);
create table if not exists costos_ruta (
  ruta_id uuid primary key references rutas(id) on delete cascade,
  km_plan numeric(8,1), km_real numeric(8,1), litros_esperados numeric(8,2), litros_reales numeric(8,2), desviacion_pct numeric(6,1),
  costo_combustible numeric(10,2), costo_peajes numeric(10,2), costo_mano_obra numeric(10,2), costo_mantenimiento numeric(10,2),
  costo_total numeric(12,2), valor_vendido numeric(12,2), entregas int, costo_por_entrega numeric(10,2), costo_por_km numeric(10,3), pct_sobre_venta numeric(6,2),
  calculado_at timestamptz default now()
);
create table if not exists posiciones (
  id bigint generated always as identity primary key,
  ruta_id uuid references rutas(id) on delete cascade, lat double precision, lng double precision, velocidad numeric(5,1), ts timestamptz default now()
);

create index if not exists ix_pedidos_estado on pedidos(fecha, estado);
create index if not exists ix_paradas_ruta on paradas(ruta_id, secuencia);
create index if not exists ix_eventos_ruta on eventos(ruta_id, created_at);
create index if not exists ix_auditoria on auditoria(created_at desc);

-- Vistas útiles para tableros
create or replace view v_torre as
select r.id, r.codigo, r.fecha, r.estado, r.version, v.placa, r.conductor, r.valor, r.km_plan, r.km_real,
  (select count(*) from paradas p where p.ruta_id=r.id and p.tipo='entrega') as entregas,
  (select count(*) from paradas p where p.ruta_id=r.id and p.estado='atendida') as atendidas,
  (select count(*) from paradas p where p.ruta_id=r.id and p.estado in ('parcial','no_entregada')) as novedades
from rutas r left join vehiculos v on v.id=r.vehiculo_id;

-- RLS DEMO: acceso total con clave anon (¡solo demo!)
do $$ declare t text; begin
  foreach t in array array['bodegas','zonas','clientes','articulos','vehiculos','personas','reglas','pedidos','pedido_lineas','rutas','paradas','manifiestos','manifiesto_lineas','eventos','incidencias','alertas','auditoria','abastecimientos','peajes','costos_ruta','posiciones'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists demo_all on %I', t);
    execute format('create policy demo_all on %I for all to anon, authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- Realtime para la torre de control (posiciones y paradas en vivo)
do $$ begin
  begin alter publication supabase_realtime add table paradas; exception when others then null; end;
  begin alter publication supabase_realtime add table eventos; exception when others then null; end;
  begin alter publication supabase_realtime add table posiciones; exception when others then null; end;
  begin alter publication supabase_realtime add table rutas; exception when others then null; end;
end $$;
