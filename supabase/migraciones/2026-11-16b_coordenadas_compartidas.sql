-- DGP · Coordenadas compartidas entre el cliente y sus direcciones de entrega (16-nov-2026)
-- Idempotente. Requiere 2026-11-16_rutas_direcciones.sql.
-- Una dirección se consulta a Google una sola vez:
--   · Una dirección de entrega que ya existe (misma clave) conserva sus coordenadas en cada pedido nuevo (ya era así).
--   · Al geocodificar una dirección de entrega, el cliente sin coordenadas cuya dirección principal es el mismo texto las toma.
--   · Al geocodificar el cliente, sus direcciones de entrega sin coordenadas con el mismo texto las toman.
--   · Una dirección de entrega nueva con el mismo texto que la principal ya geocodificada nace con sus coordenadas.

-- Texto comparable: minúsculas, sin tildes, solo letras y números
create or replace function dgp_private.norm_dir(t text) returns text
language sql immutable set search_path = pg_temp as $$
  select trim(regexp_replace(lower(translate(coalesce(t, ''), 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun')), '[^a-z0-9]+', ' ', 'g')) $$;

-- Dirección de entrega geocodificada → cliente (si no tiene coordenadas y es la misma dirección)
create or replace function dgp_private.dir_a_cliente() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.lat is not null and (old.lat is distinct from new.lat or old.lng is distinct from new.lng) then
    update clientes c set lat = new.lat, lng = new.lng, geo_estado = new.geo_estado, geo_fuente = new.geo_fuente,
           geo_detalle = new.geo_detalle, updated_at = now()
     where c.id = new.cliente_id and c.lat is null and dgp_private.norm_dir(c.direccion) = dgp_private.norm_dir(new.direccion);
  end if;
  return new;
end $$;
drop trigger if exists tr_dir_a_cliente on cliente_direcciones;
create trigger tr_dir_a_cliente after update of lat, lng on cliente_direcciones
  for each row execute function dgp_private.dir_a_cliente();

-- Cliente geocodificado → sus direcciones de entrega sin coordenadas con el mismo texto (y, por tr_propagar_direccion, sus pedidos)
create or replace function dgp_private.cliente_a_dir() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.lat is not null and (old.lat is distinct from new.lat or old.lng is distinct from new.lng) then
    update cliente_direcciones d set lat = new.lat, lng = new.lng, geo_estado = new.geo_estado, geo_fuente = new.geo_fuente,
           geo_detalle = new.geo_detalle, geo_at = now(), updated_at = now()
     where d.cliente_id = new.id and d.lat is null and dgp_private.norm_dir(d.direccion) = dgp_private.norm_dir(new.direccion);
  end if;
  return new;
end $$;
drop trigger if exists tr_cliente_a_dir on clientes;
create trigger tr_cliente_a_dir after update of lat, lng on clientes
  for each row execute function dgp_private.cliente_a_dir();

-- Alta de dirección de entrega: si el cliente ya tiene coordenadas para ese mismo texto, la dirección nace con ellas
drop function if exists public.zoho_guardar_direccion(uuid, jsonb);
create or replace function public.zoho_guardar_direccion(cliente uuid, d jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r cliente_direcciones; c clientes;
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
  select * into c from clientes where id = cliente;
  if r.lat is null and c.lat is not null and dgp_private.norm_dir(c.direccion) = dgp_private.norm_dir(r.direccion) then
    update cliente_direcciones set lat = c.lat, lng = c.lng, geo_estado = c.geo_estado, geo_fuente = c.geo_fuente, geo_detalle = c.geo_detalle, geo_at = now()
     where id = r.id returning * into r;
  end if;
  update clientes set direccion = r.direccion, updated_at = now() where id = cliente and direccion is null;
  return to_jsonb(r) || jsonb_build_object('nueva', r.created_at = r.updated_at);
end $$;
revoke execute on function public.zoho_guardar_direccion(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.zoho_guardar_direccion(uuid, jsonb) to service_role;

-- Ponerse al día: lo ya geocodificado se comparte ahora mismo
update clientes c set lat = d.lat, lng = d.lng, geo_estado = d.geo_estado, geo_fuente = d.geo_fuente, geo_detalle = d.geo_detalle, updated_at = now()
  from cliente_direcciones d
 where d.cliente_id = c.id and c.lat is null and d.lat is not null and dgp_private.norm_dir(c.direccion) = dgp_private.norm_dir(d.direccion);
update cliente_direcciones d set lat = c.lat, lng = c.lng, geo_estado = c.geo_estado, geo_fuente = c.geo_fuente, geo_detalle = c.geo_detalle, geo_at = now(), updated_at = now()
  from clientes c
 where d.cliente_id = c.id and d.lat is null and c.lat is not null and dgp_private.norm_dir(c.direccion) = dgp_private.norm_dir(d.direccion);
