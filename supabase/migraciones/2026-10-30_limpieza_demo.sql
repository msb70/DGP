-- DGP · Limpieza de datos de demostración en producción (30-oct-2026)
-- NO SE HA EJECUTADO. Requiere aprobación de Miguel.
-- Borra solo la demo del 5–9 de octubre: 36 clientes manuales (C001–C036), sus 40 pedidos (SO-5201…, ids zso_ ficticios),
-- las 7 rutas R-01…R-07 del 9-oct con todo lo que cuelga de ellas, y alertas, avisos, incentivos y acta de esa demo.
-- NO toca: clientes y artículos de Zoho, personas, vehículos, zonas, bodegas, reglas, usuarios/roles/permisos, integraciones,
-- sync_log ni auditoría (inmutable por diseño).
-- Todo en una transacción: si un conteo no coincide con lo esperado, aborta y no borra nada.

begin;

create temp table _demo_cli on commit drop as select id from clientes where zoho_contact_id is null and origen = 'manual';
create temp table _demo_ped on commit drop as select id from pedidos where cliente_id in (select id from _demo_cli) or zoho_salesorder_id like 'zso\_%';
create temp table _demo_rut on commit drop as select id from rutas where fecha <= '2026-10-09';

do $$ begin
  if (select count(*) from _demo_cli) <> 36 then raise exception 'Se esperaban 36 clientes demo, hay %', (select count(*) from _demo_cli); end if;
  if (select count(*) from _demo_ped) <> 40 then raise exception 'Se esperaban 40 pedidos demo, hay %', (select count(*) from _demo_ped); end if;
  if (select count(*) from _demo_rut) <> 7  then raise exception 'Se esperaban 7 rutas demo, hay %', (select count(*) from _demo_rut); end if;
  if exists (select 1 from pedidos p join clientes c on c.id = p.cliente_id where p.id in (select id from _demo_ped) and c.zoho_contact_id is not null)
    then raise exception 'Hay pedidos demo enlazados a clientes reales de Zoho: revisar antes de borrar'; end if;
end $$;

-- Rutas: en cascada caen paradas, eventos, manifiestos y sus líneas, incidencias, abastecimientos, peajes, costos, posiciones y paquetes
delete from paradas where ruta_id in (select id from _demo_rut) or pedido_id in (select id from _demo_ped) or cliente_id in (select id from _demo_cli);
delete from rutas   where id in (select id from _demo_rut);
-- Pedidos: en cascada caen pedido_lineas y paquetes
delete from pedidos where id in (select id from _demo_ped);
delete from clientes where id in (select id from _demo_cli);

delete from alertas        where created_at::date <= '2026-10-09';
delete from notificaciones where created_at::date <= '2026-10-09' and canal = 'telegram' and estado = 'simulado';
delete from incentivos     where fecha <= '2026-10-09';
delete from actas_gd       where fecha <= '2026-10-09';

select (select count(*) from clientes where zoho_contact_id is null) clientes_demo_restantes,
       (select count(*) from pedidos) pedidos, (select count(*) from rutas) rutas, (select count(*) from paradas) paradas,
       (select count(*) from clientes) clientes_total, (select count(*) from articulos) articulos;

commit;
