/* DGP · Catálogos de la app del conductor (20-nov-2026): causas de entrega parcial / no entregada y tipos de incidente.
   Común a la torre y a la app. Si la tabla está vacía (modo demo) se usan los valores de fábrica, que son los mismos
   que carga la migración 2026-11-20_catalogos_entrega_incidentes.sql. */
const CE_DEF = [
  ['faltante', 'Faltante de mercancía (no venía en el camión)', 'parcial', false, 1], ['danado', 'Producto dañado o golpeado', 'ambas', false, 2],
  ['vencido', 'Producto vencido o con fecha corta', 'ambas', false, 3], ['mal_empacado', 'Mal empacado (devolución por empaque)', 'parcial', false, 4],
  ['producto_errado', 'Producto no corresponde al pedido', 'ambas', false, 5], ['rechaza_cantidad', 'Cliente rechaza parte de la cantidad', 'parcial', false, 6],
  ['sin_espacio', 'Espacio insuficiente en la bodega del cliente', 'parcial', false, 7], ['precio', 'Precio no coincide con lo pactado', 'ambas', true, 8],
  ['cerrado', 'Cliente cerrado o fuera de horario de recibo', 'no_entrega', false, 20], ['sin_autorizado', 'Sin persona autorizada para recibir', 'no_entrega', false, 21],
  ['rechaza_pedido', 'Cliente rechaza el pedido completo', 'no_entrega', true, 22], ['no_pidio', 'Cliente no hizo el pedido o está duplicado', 'no_entrega', false, 23],
  ['direccion', 'Dirección incorrecta o no encontrada', 'no_entrega', false, 24], ['pago', 'Sin pago o crédito bloqueado (contra entrega)', 'no_entrega', false, 25],
  ['sin_tiempo', 'No se llegó a tiempo (tráfico, ruta o incidente)', 'no_entrega', false, 26], ['acceso', 'Acceso restringido o sin espacio para descargar', 'no_entrega', false, 27],
  ['otra', 'Otra (explicar en la nota)', 'ambas', true, 99]
].map(([codigo, nombre, aplica, requiere_nota, orden]) => ({ codigo, nombre, aplica, requiere_nota, orden, activa: true }));
const TI_DEF = [
  ['averia', 'Avería mecánica', 'alta', 'Mantenimiento', false, 1], ['llanta', 'Llanta ponchada o baja', 'media', 'Mantenimiento', false, 2],
  ['bateria', 'Batería o el camión no enciende', 'alta', 'Mantenimiento', false, 3], ['combustible', 'Falta de combustible', 'media', 'Operaciones', false, 4],
  ['accidente', 'Accidente de tránsito', 'alta', 'Gerencia de operaciones', true, 5], ['robo', 'Robo o asalto', 'alta', 'Gerencia de operaciones', true, 6],
  ['policia', 'Retén o control de tránsito / policía', 'baja', 'Operaciones', false, 7], ['via_cerrada', 'Vía cerrada, protesta o acceso bloqueado', 'media', 'Operaciones', false, 8],
  ['clima', 'Lluvia fuerte o inundación', 'media', 'Operaciones', false, 9], ['carga', 'Mercancía dañada o movida en el camión', 'media', 'Operaciones', false, 10],
  ['salud', 'Problema de salud del conductor o ayudante', 'alta', 'Gerencia de operaciones', false, 11], ['equipo', 'Falla del celular, la app o el GPS', 'baja', 'Operaciones', false, 12],
  ['otro', 'Otro (explicar)', 'media', 'Operaciones', true, 99]
].map(([codigo, nombre, severidad, avisar_a, requiere_nota, orden]) => ({ codigo, nombre, severidad, avisar_a, requiere_nota, orden, activa: true }));
const catOrden = (a, b) => (a.orden ?? 99) - (b.orden ?? 99) || a.nombre.localeCompare(b.nombre);
const catActivos = (rows, def) => (rows && rows.length ? rows : def).filter(x => x.activa !== false).slice().sort(catOrden);
/* Causas para el botón pulsado: 'parcial' o 'no_entrega' (+ las que aplican a ambas). */
const causasEntregaPara = (rows, tipo) => catActivos(rows, CE_DEF).filter(c => c.aplica === tipo || c.aplica === 'ambas');
const tiposIncidenteActivos = rows => catActivos(rows, TI_DEF);
