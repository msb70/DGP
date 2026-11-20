-- DGP · Catálogos de la app del conductor (20-nov-2026). Idempotente. Aplicada como catalogos_entrega_incidentes_20261120.
-- · causas_entrega: causas de entrega PARCIAL y de NO ENTREGADA (columna aplica), editables en Catálogo.
-- · tipos_incidente: tipos de incidente con severidad y a quién se avisa, editables en Catálogo.
-- · clientes.recibe_defecto: quién recibe normalmente en el cliente; la app lo propone en «Recibe».
--   (Antes proponía clientes.contacto, que es el contacto de Zoho y no necesariamente quien recibe.)
-- · incidencias.foto: foto opcional del incidente tomada desde la app.
-- Se desactivan, no se borran (los registros guardan el texto usado).

alter table public.clientes add column if not exists recibe_defecto text check (recibe_defecto is null or length(recibe_defecto) <= 80);
alter table public.incidencias add column if not exists foto text;

create table if not exists public.causas_entrega (
  codigo        text primary key check (codigo ~ '^[a-z0-9_]{1,30}$'),
  nombre        text not null check (length(trim(nombre)) between 3 and 120),
  aplica        text not null default 'ambas' check (aplica in ('parcial', 'no_entrega', 'ambas')),
  requiere_nota boolean not null default false,
  orden         integer,
  activa        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create table if not exists public.tipos_incidente (
  codigo        text primary key check (codigo ~ '^[a-z0-9_]{1,30}$'),
  nombre        text not null check (length(trim(nombre)) between 3 and 120),
  severidad     text not null default 'media' check (severidad in ('baja', 'media', 'alta')),
  avisar_a      text not null default 'Operaciones',
  requiere_nota boolean not null default false,
  orden         integer,
  activa        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

do $$ declare t text; begin
  foreach t in array array['causas_entrega', 'tipos_incidente'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
    insert into dgp_private.tabla_permisos (tabla, permisos) values (t, array['catalogo.editar']) on conflict (tabla) do update set permisos = excluded.permisos;
    execute format('drop policy if exists p_sel on public.%I', t);
    execute format('drop policy if exists p_ins on public.%I', t);
    execute format('drop policy if exists p_upd on public.%I', t);
    execute format('create policy p_sel on public.%I for select to authenticated using (dgp_private.perfil_activo())', t);
    execute format('create policy p_ins on public.%I for insert to authenticated with check (dgp_private.escribe(%L))', t, t);
    execute format('create policy p_upd on public.%I for update to authenticated using (dgp_private.escribe(%L)) with check (dgp_private.escribe(%L))', t, t, t);
    execute format('drop trigger if exists tr_sin_html on public.%I', t);
    execute format('create trigger tr_sin_html before insert or update on public.%I for each row execute function dgp_private.sin_html()', t);
  end loop;
end $$;

insert into public.causas_entrega (codigo, nombre, aplica, requiere_nota, orden) values
  -- parcial
  ('faltante',          'Faltante de mercancía (no venía en el camión)', 'parcial', false, 1),
  ('danado',            'Producto dañado o golpeado', 'ambas', false, 2),
  ('vencido',           'Producto vencido o con fecha corta', 'ambas', false, 3),
  ('mal_empacado',      'Mal empacado (devolución por empaque)', 'parcial', false, 4),
  ('producto_errado',   'Producto no corresponde al pedido', 'ambas', false, 5),
  ('rechaza_cantidad',  'Cliente rechaza parte de la cantidad', 'parcial', false, 6),
  ('sin_espacio',       'Espacio insuficiente en la bodega del cliente', 'parcial', false, 7),
  ('precio',            'Precio no coincide con lo pactado', 'ambas', true, 8),
  -- no entregada
  ('cerrado',           'Cliente cerrado o fuera de horario de recibo', 'no_entrega', false, 20),
  ('sin_autorizado',    'Sin persona autorizada para recibir', 'no_entrega', false, 21),
  ('rechaza_pedido',    'Cliente rechaza el pedido completo', 'no_entrega', true, 22),
  ('no_pidio',          'Cliente no hizo el pedido o está duplicado', 'no_entrega', false, 23),
  ('direccion',         'Dirección incorrecta o no encontrada', 'no_entrega', false, 24),
  ('pago',              'Sin pago o crédito bloqueado (contra entrega)', 'no_entrega', false, 25),
  ('sin_tiempo',        'No se llegó a tiempo (tráfico, ruta o incidente)', 'no_entrega', false, 26),
  ('acceso',            'Acceso restringido o sin espacio para descargar', 'no_entrega', false, 27),
  ('otra',              'Otra (explicar en la nota)', 'ambas', true, 99)
on conflict (codigo) do nothing;

insert into public.tipos_incidente (codigo, nombre, severidad, avisar_a, requiere_nota, orden) values
  ('averia',      'Avería mecánica', 'alta', 'Mantenimiento', false, 1),
  ('llanta',      'Llanta ponchada o baja', 'media', 'Mantenimiento', false, 2),
  ('bateria',     'Batería o el camión no enciende', 'alta', 'Mantenimiento', false, 3),
  ('combustible', 'Falta de combustible', 'media', 'Operaciones', false, 4),
  ('accidente',   'Accidente de tránsito', 'alta', 'Gerencia de operaciones', true, 5),
  ('robo',        'Robo o asalto', 'alta', 'Gerencia de operaciones', true, 6),
  ('policia',     'Retén o control de tránsito / policía', 'baja', 'Operaciones', false, 7),
  ('via_cerrada', 'Vía cerrada, protesta o acceso bloqueado', 'media', 'Operaciones', false, 8),
  ('clima',       'Lluvia fuerte o inundación', 'media', 'Operaciones', false, 9),
  ('carga',       'Mercancía dañada o movida en el camión', 'media', 'Operaciones', false, 10),
  ('salud',       'Problema de salud del conductor o ayudante', 'alta', 'Gerencia de operaciones', false, 11),
  ('equipo',      'Falla del celular, la app o el GPS', 'baja', 'Operaciones', false, 12),
  ('otro',        'Otro (explicar)', 'media', 'Operaciones', true, 99)
on conflict (codigo) do nothing;

-- Cerrar la ruta exige el odómetro de llegada (> 0 y no menor que el de salida). Aplicada como cierre_odometro_obligatorio_20261120.
create or replace function dgp_private.cierre_con_odometro() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.estado = 'cerrada' and old.estado is distinct from 'cerrada' then
    if new.odometro_llegada is null or new.odometro_llegada <= 0 then
      raise exception 'La ruta % no se puede cerrar sin el odómetro de llegada', new.codigo;
    end if;
    if new.odometro_salida is not null and new.odometro_llegada < new.odometro_salida then
      raise exception 'El odómetro de llegada (%) no puede ser menor que el de salida (%)', new.odometro_llegada, new.odometro_salida;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists tr_cierre_con_odometro on public.rutas;
create trigger tr_cierre_con_odometro before update of estado on public.rutas for each row execute function dgp_private.cierre_con_odometro();
