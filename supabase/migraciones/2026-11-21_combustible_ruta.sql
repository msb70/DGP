-- 21-nov: nivel de combustible a la salida y a la llegada del viaje (el conductor lo marca en su app; sale en el acta de recepción)
alter table public.rutas add column if not exists combustible_salida text, add column if not exists combustible_llegada text;
alter table public.rutas drop constraint if exists rutas_combustible_chk;
alter table public.rutas add constraint rutas_combustible_chk check (
  (combustible_salida is null or combustible_salida in ('Lleno','3/4','1/2','1/4','Reserva')) and
  (combustible_llegada is null or combustible_llegada in ('Lleno','3/4','1/2','1/4','Reserva')));
drop trigger if exists tr_guardia_conductor on public.rutas;
create trigger tr_guardia_conductor before update on public.rutas for each row execute function dgp_private.guardia_conductor(
  'estado,area_cargue_at,verificador_llamado_at,salida_at,odometro_salida,pallets_salida,version,hora_fin_prevista,pallets_retorno,pallets_buen_estado,llegada_at,odometro_llegada,km_real,updated_at,combustible_salida,combustible_llegada',
  'liberada>en_ruta,en_ruta>cerrada');
-- rutas que ya salieron: se recupera el nivel de salida del evento «salida» registrado por la app
update public.rutas r set combustible_salida = e.detalle->>'combustible'
from (select distinct on (ruta_id) ruta_id, detalle from public.eventos where tipo = 'salida' and detalle ? 'combustible' order by ruta_id, created_at desc) e
where e.ruta_id = r.id and r.combustible_salida is null and e.detalle->>'combustible' in ('Lleno','3/4','1/2','1/4','Reserva');
