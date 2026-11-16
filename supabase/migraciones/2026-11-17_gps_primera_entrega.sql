-- DGP · La ubicación real de una dirección sale del GPS del conductor en la primera entrega (17-nov-2026)
-- Idempotente. Requiere 2026-11-16_rutas_direcciones.sql y 2026-11-16b_coordenadas_compartidas.sql.
--
-- Las coordenadas por dirección (Apps Script / Google) casi siempre son «aproximadas»: el centro del barrio o del pueblo.
-- Cuando el conductor entrega (total o parcial) con GPS en el check-in, esa posición pasa a ser la coordenada de la dirección
-- de entrega (geo_estado = 'validada', geo_fuente = 'gps_entrega'). Desde la siguiente visita la parada cae en la puerta.
--   · Solo la primera vez: una dirección 'validada' no se vuelve a mover (si hay que corregirla, se hace a mano en Catálogo).
--   · Filtro de errores: el GPS debe estar en Panamá y, si la dirección ya tenía coordenada aproximada, a menos de
--     reglas.gps_entrega.max_km (20 km por defecto) de ella. Si no, se deja como estaba y queda una alerta para revisar.
--   · La coordenada validada se comparte con el cliente y sus otras direcciones con el mismo texto (triggers de 2026-11-16b,
--     que ahora también mejoran una coordenada aproximada cuando llega una validada).

insert into reglas (clave, valor, descripcion, accion)
values ('gps_entrega', '{"activo": true, "max_km": 20}', 'En la primera entrega a una dirección sin coordenada exacta, el GPS del check-in del conductor pasa a ser su coordenada (validada). max_km: distancia máxima aceptada respecto a la coordenada aproximada.', 'coordenadas')
on conflict (clave) do nothing;
insert into reglas (clave, valor, descripcion, accion)
values ('checkin_radio_aproximada', '{"metros": 3000}', 'Radio del check-in cuando la dirección solo tiene coordenada aproximada (centro del barrio o pueblo): no salta la alerta de «fuera del radio» por estar en la puerta del cliente.', 'conductor')
on conflict (clave) do nothing;

-- Distancia en km entre dos puntos (haversine)
create or replace function dgp_private.km(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision) returns double precision
language sql immutable set search_path = pg_temp as $$
  select 6371 * 2 * asin(sqrt(power(sin(radians(lat2 - lat1) / 2), 2) + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))) $$;

create or replace function dgp_private.gps_entrega() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare p pedidos; d cliente_direcciones; regla jsonb; maxkm double precision; dist double precision;
begin
  if new.pedido_id is null or new.checkin_lat is null or new.checkin_lng is null then return new; end if;
  if new.estado not in ('atendida', 'parcial') or old.estado in ('atendida', 'parcial') then return new; end if;
  select valor into regla from reglas where clave = 'gps_entrega';
  if coalesce((regla->>'activo')::boolean, true) is false then return new; end if;
  maxkm := coalesce((regla->>'max_km')::double precision, 20);
  select * into p from pedidos where id = new.pedido_id;
  if p.direccion_id is null then return new; end if;
  select * into d from cliente_direcciones where id = p.direccion_id for update;
  if not found or d.geo_estado = 'validada' then return new; end if;
  if new.checkin_lat not between 7 and 9.7 or new.checkin_lng not between -83.1 and -77.1 then return new; end if;
  if d.lat is not null then
    dist := dgp_private.km(d.lat, d.lng, new.checkin_lat, new.checkin_lng);
    if dist > maxkm then
      insert into alertas (tipo, severidad, titulo, detalle, entidad, destinatario)
      values ('direccion', 'media', format('%s: GPS de la entrega a %s km de la dirección', p.numero_so, round(dist::numeric, 1)),
              format('El check-in del conductor quedó a %s km de la coordenada aproximada de «%s». No se guardó: revisar la dirección en Zoho o fijarla a mano en Catálogo.', round(dist::numeric, 1), left(d.direccion, 120)),
              'pedido', 'Torre de control');
      return new;
    end if;
  end if;
  update cliente_direcciones set lat = new.checkin_lat, lng = new.checkin_lng, geo_estado = 'validada', geo_fuente = 'gps_entrega',
         geo_detalle = left(format('GPS del conductor al entregar %s (%s)%s', p.numero_so, to_char(coalesce(new.checkin_at, now()) at time zone 'America/Panama', 'DD-MM-YYYY HH24:MI'),
                       case when dist is not null then format(' · %s km de la aproximada', round(dist::numeric, 1)) else '' end), 300),
         geo_at = now(), updated_at = now()
   where id = d.id;
  insert into auditoria (entidad, accion, detalle, actor, automatico)
  values ('cliente_direcciones', 'gps_entrega', format('Coordenada fijada por GPS de entrega: %s · %s', p.numero_so, left(d.direccion, 150)), 'conductor (GPS)', true);
  return new;
end $$;
drop trigger if exists tr_gps_entrega on paradas;
create trigger tr_gps_entrega after update of estado on paradas
  for each row execute function dgp_private.gps_entrega();

-- Una coordenada validada (GPS o corrección manual) también mejora a la del cliente / otras direcciones que solo eran aproximadas
create or replace function dgp_private.dir_a_cliente() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.lat is not null and (old.lat is distinct from new.lat or old.lng is distinct from new.lng) then
    update clientes c set lat = new.lat, lng = new.lng, geo_estado = new.geo_estado, geo_fuente = new.geo_fuente,
           geo_detalle = new.geo_detalle, updated_at = now()
     where c.id = new.cliente_id and dgp_private.norm_dir(c.direccion) = dgp_private.norm_dir(new.direccion)
       and (c.lat is null or (new.geo_estado = 'validada' and coalesce(c.geo_estado, '') not in ('validada', 'automatica')));
  end if;
  return new;
end $$;
create or replace function dgp_private.cliente_a_dir() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.lat is not null and (old.lat is distinct from new.lat or old.lng is distinct from new.lng) then
    update cliente_direcciones d set lat = new.lat, lng = new.lng, geo_estado = new.geo_estado, geo_fuente = new.geo_fuente,
           geo_detalle = new.geo_detalle, geo_at = now(), updated_at = now()
     where d.cliente_id = new.id and dgp_private.norm_dir(d.direccion) = dgp_private.norm_dir(new.direccion)
       and (d.lat is null or (new.geo_estado = 'validada' and coalesce(d.geo_estado, '') not in ('validada', 'automatica')));
  end if;
  return new;
end $$;
