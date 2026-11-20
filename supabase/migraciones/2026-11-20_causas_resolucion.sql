-- DGP · Catálogo de causas de resolución de excepciones (20-nov-2026).
-- Las usa Pedidos → «Resolver excepción» (agregar a ruta / viaje nuevo / diferir). Se editan en Catálogo → Causas de resolución.
-- No se borran: se desactivan (la auditoría guarda el texto de la causa usada). Idempotente.
create table if not exists public.causas_resolucion (
  codigo        text primary key check (codigo ~ '^[a-z0-9_]{1,30}$'),
  nombre        text not null check (length(trim(nombre)) between 3 and 120),
  requiere_nota boolean not null default false,
  orden         integer,
  activa        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.causas_resolucion enable row level security;
revoke all on public.causas_resolucion from anon;
grant select, insert, update on public.causas_resolucion to authenticated;

insert into dgp_private.tabla_permisos (tabla, permisos) values ('causas_resolucion', array['catalogo.editar'])
on conflict (tabla) do update set permisos = excluded.permisos;

drop policy if exists p_sel on public.causas_resolucion;
drop policy if exists p_ins on public.causas_resolucion;
drop policy if exists p_upd on public.causas_resolucion;
create policy p_sel on public.causas_resolucion for select to authenticated using (dgp_private.perfil_activo());
create policy p_ins on public.causas_resolucion for insert to authenticated with check (dgp_private.escribe('causas_resolucion'));
create policy p_upd on public.causas_resolucion for update to authenticated using (dgp_private.escribe('causas_resolucion')) with check (dgp_private.escribe('causas_resolucion'));

drop trigger if exists tr_sin_html on public.causas_resolucion;
create trigger tr_sin_html before insert or update on public.causas_resolucion for each row execute function dgp_private.sin_html();

insert into public.causas_resolucion (codigo, nombre, requiere_nota, orden) values
  ('gerencia',  'Autorizado por gerencia de operaciones', false, 1),
  ('credito',   'Crédito autorizado por CxC / ejecutivo', false, 2),
  ('minimo',    'Monto bajo el mínimo aceptado (cliente estratégico o urgencia)', false, 3),
  ('direccion', 'Dirección confirmada con el cliente o el ejecutivo', false, 4),
  ('ruta_zoho', 'Ruta de Zoho asignada a mano', false, 5),
  ('otra',      'Otra (explicar en la nota)', true, 99)
on conflict (codigo) do nothing;
