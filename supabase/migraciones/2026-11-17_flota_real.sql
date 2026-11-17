-- Flota real de DGP (LISTADO DE AUTOS - PLACAS.xlsx, 17-nov-2026). Idempotente.
-- Capacidades: las del cuestionario de DGP (panel baja 1.000 kg/4 m³/86 cajas; panel alta 5 m³/120 cajas; camión 3.000 kg/9 m³/620 cajas)
-- con el peso del listado cuando es carga útil. Pendientes de confirmar por DGP (ver auditoría).
alter table vehiculos add column if not exists anio int;
alter table vehiculos add column if not exists mes_placa text;        -- mes de renovación de placa
alter table vehiculos add column if not exists municipio text;
alter table vehiculos add column if not exists combustible text;

insert into vehiculos (placa, nombre, tipo, anio, mes_placa, municipio, combustible, cap_peso_kg, cap_volumen_m3, cap_cajas, programa_incentivo, color, color_nombre, activo) values
 ('CY1330', 'Nissan Urvan Panel (1 t)',                  'panel_baja', 2020, 'Noviembre', 'Panamá',   'Diésel',   1000, 4, 86,  'paneles',  '#7C3AED', 'Morado',   true),
 ('ED1349', 'Nissan Urvan Panel (1 t)',                  'panel_baja', 2022, 'Junio',     'Panamá',   'Diésel',   1000, 4, 86,  'paneles',  '#DB2777', 'Rosado',   true),
 ('DE2623', 'Camión Isuzu NQR75L-LN5AYN (8 t)',          'camion',     2023, 'Abril',     'La Chorrera', 'Diésel', 3000, 9, 620, 'camiones', '#DC2626', 'Rojo',     true),
 ('DE4837', 'Nissan Urvan (1 t)',                        'panel_baja', 2024, 'Diciembre', 'La Chorrera', 'Diésel', 1000, 4, 86,  'paneles',  '#0891B2', 'Celeste',  true),
 ('DE9093', 'Maxus Panel V90 L3H2 (2 t)',                'panel_alta', 2026, 'Noviembre', 'La Chorrera', 'Diésel', 2000, 5, 120, 'paneles',  '#2563EB', 'Azul',     true),
 ('DI1897', 'Nissan Urvan (1 t)',                        'panel_baja', 2026, 'Agosto',    'La Chorrera', 'Diésel', 1000, 4, 86,  'paneles',  '#16A34A', 'Verde',    true),
 ('DI5317', 'Nissan Urvan (1 t)',                        'panel_baja', 2026, 'Mayo',      'La Chorrera', 'Diésel', 1000, 4, 86,  'paneles',  '#EA580C', 'Naranja',  true),
 ('DI5594', 'Forthing M5 (sin capacidad de carga indicada)', 'otro',   2026, 'Junio',     'La Chorrera', 'Gasolina', 0,    0, 0,   null,       '#64748B', 'Gris',     false)
on conflict (placa) do update set nombre = excluded.nombre, tipo = excluded.tipo, anio = excluded.anio, mes_placa = excluded.mes_placa,
  municipio = excluded.municipio, combustible = excluded.combustible;   -- re-ejecutar no pisa capacidades ni estado editados después

-- Vehículos ficticios de la demo: inactivos (no se borran; rutas históricas los referencian)
update vehiculos set activo = false where placa in ('CA-4410','CA-4411','PA-1042','PA-1187','PA-1203','PB-2015','PB-2016','PB-2017') and activo is distinct from false;

insert into auditoria (entidad, accion, detalle, actor, automatico)
select 'vehiculos', 'flota_real', 'Cargada la flota real de DGP (8 placas desde LISTADO DE AUTOS - PLACAS.xlsx); 7 activas, Forthing M5 inactivo sin capacidad; los 8 vehículos ficticios pasan a inactivos. Capacidades de cajas y m³ tomadas del cuestionario, pendientes de confirmar.', 'Claude (migración)', true
where not exists (select 1 from auditoria where entidad = 'vehiculos' and accion = 'flota_real');
