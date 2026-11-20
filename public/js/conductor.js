/* DGP · App del conductor (PWA, offline-first) */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hhmm = m => { const t = ((Math.round(m) % 1440) + 1440) % 1440; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; }; // TIME-001: se redondea el total antes de separar (nunca minuto 60); pasada la medianoche vuelve a 00:00
const tmin = s => { if (!s) return 0; const [a, b] = s.split(':').map(Number); return a * 60 + b; };
const fmt = n => (+n || 0).toLocaleString('es-PA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toast = t => { const e = $('toast'); e.textContent = t; e.classList.add('on'); clearTimeout(e._t); e._t = setTimeout(() => e.classList.remove('on'), 2800); };
let S = { paquetes: [], vehiculos: [], conductor: null, rutas: [], todas: [], paradasTodas: [], incidencias: [], ruta: null, paradas: [], clientes: [], pedidos: [], lineas: [], articulos: [], reglas: {}, bodega: null, simOffline: false, screen: 'home', form: {} };
// -------- cola offline --------
const PROD = !!(window.DGP_CONFIG && window.DGP_CONFIG.produccion);
/* Errores que no se arreglan reintentando (permiso, datos inválidos): el evento pasa a "no sincronizados" y no bloquea la cola. */
const permanente = e => { const c = String((e && e.code) || ''); return c === '42501' || c.startsWith('23') || c.startsWith('22') || /^PGRST(1|2)/.test(c); };
const Q = {
  get key() { return 'dgp_queue' + (window.Auth && Auth.activo ? '_' + Auth.perfil.id : ''); },
  dead() { try { return JSON.parse(localStorage.getItem(this.key + '_err') || '[]'); } catch (e) { return []; } },
  bury(op, e) { const d = this.dead(); d.push(Object.assign({ error: (window.Auth ? Auth.errorTexto(e) : e.message) }, op)); localStorage.setItem(this.key + '_err', JSON.stringify(d.slice(-200))); },
  list() { try { return JSON.parse(localStorage.getItem(this.key) || '[]'); } catch (e) { return []; } }, save(l) { localStorage.setItem(this.key, JSON.stringify(l)); },
  online() { return navigator.onLine && !S.simOffline; },
  async run(op) { if (op.fn === 'rpc') return DB.rpc(op.name, op.args); if (op.fn === 'insert') { const r = await DB.insert(op.table, op.rows, { idempotente: true }); if (op.table === 'notificaciones') DB.despachar(r); return r; } if (op.fn === 'update') return DB.update(op.table, op.match, op.patch); },
  /* FUN-06: cada fila recibe su id ANTES del primer intento; si se pierde la respuesta tras guardar, el reintento reutiliza el id y no duplica. */
  conId(op) { if (op.fn === 'insert' && !['auditoria', 'posiciones', 'sync_log'].includes(op.table)) op.rows = (Array.isArray(op.rows) ? op.rows : [op.rows]).map(r => r.id ? r : Object.assign({ id: DB.uuid() }, r)); return op; },
  async push(op) { this.conId(op); if (this.online()) { try { await this.run(op); return 'ok'; } catch (e) { if (permanente(e)) { this.bury(op, e); toast('No se pudo guardar: ' + (window.Auth ? Auth.errorTexto(e) : e.message)); header(); return 'rechazado'; } console.warn('fallo, a cola', e); } } const l = this.list(); l.push(Object.assign({ ts: new Date().toISOString() }, op)); this.save(l); header(); return 'cola'; },
  async flush() { if (!this.online()) return; let l = this.list(); if (!l.length) return; const n = l.length; for (const op of l) { try { if (op.fn === 'insert') op.rows = (Array.isArray(op.rows) ? op.rows : [op.rows]).map(r => Object.assign({}, r, r.offline !== undefined ? { offline: true } : {})); await this.run(op); l = l.slice(1); this.save(l); } catch (e) { if (permanente(e)) { this.bury(op, e); l = l.slice(1); this.save(l); continue; } console.warn('flush error', e); break; } } if (!this.list().length) { toast(`${n} eventos sincronizados al recuperar señal`); await load(); render(); } header(); }
};
/* DATA-001: un paso de una acción del conductor. "ok" = guardado, "cola" = sin señal (se sincroniza después),
   "rechazado" = la base lo rechazó: se detiene la acción (no se ejecutan los pasos siguientes ni se anuncia éxito). */
class Rechazo extends Error { constructor() { super('rechazado'); this.rechazo = true; } }
async function paso(op) { const r = await Q.push(op); if (r === 'rechazado') throw new Rechazo(); return r; }
/* Envuelve una acción: ante un rechazo se recarga el estado real del servidor y se vuelve a pintar (el formulario sigue disponible). */
const conRechazo = fn => async function (...a) { try { return await fn.apply(this, a); } catch (e) { if (!e || !e.rechazo) throw e; try { if (Q.online()) await load(); } catch (x) { } render(); } };
async function evento(tipo, texto, extra = {}, pos) { const p = pos || await geo(true); return paso({ fn: 'insert', table: 'eventos', rows: [{ ruta_id: S.ruta.id, parada_id: extra.parada_id || null, tipo, detalle: Object.assign({ texto }, extra.detalle || {}), lat: p ? p.lat : null, lng: p ? p.lng : null, ts_dispositivo: new Date().toISOString(), offline: !Q.online(), actor: S.conductor.nombre, created_at: new Date().toISOString() }] }); }
// -------- GPS --------
function geo(quiet) { return new Promise(res => { if (!navigator.geolocation) return res(simPos()); navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude, real: true }), () => res(simPos()), { timeout: 6000, maximumAge: 15000, enableHighAccuracy: true }); }); }
function simPos() { if (PROD) return { lat: null, lng: null, real: false }; const s = curStop(); const b = S.bodega || { lat: 8.956, lng: -79.672 }; const base = s ? s : b; return { lat: +base.lat + (Math.random() - .5) * 0.0006, lng: +base.lng + (Math.random() - .5) * 0.0006, real: false }; }
// -------- carga --------
/* FUN-07: última copia de trabajo del conductor (por usuario) para poder arrancar sin señal. Solo sus rutas y los clientes de sus paradas. */
const SNAP_MAX_H = 72;
const snapKey = () => 'dgp_snap_' + ((window.Auth && Auth.perfil && Auth.perfil.id) || (S.conductor && S.conductor.id) || 'local');
function guardarSnap() {
  try {
    const usados = new Set(S.paradasTodas.map(p => p.cliente_id));
    const snap = { ts: Date.now(), todas: S.todas, clientes: S.clientes.filter(c => usados.has(c.id)), articulos: S.articulos, reglas: S.reglasRaw || [], bodega: S.bodega, incidencias: S.incidencias, vehiculos: S.vehiculos, personasAll: S.personasAll, paradasTodas: S.paradasTodas, paquetes: S.paquetes, cobros: S.cobros || [], causasCobro: S.causasCobro || [], causasEntrega: S.causasEntrega || [], tiposIncidente: S.tiposIncidente || [], paradas: S.paradas, pedidos: S.pedidos, lineas: S.lineas, ruta: S.ruta && S.ruta.id };
    localStorage.setItem(snapKey(), JSON.stringify(snap));
  } catch (e) { console.warn('No se pudo guardar la copia sin señal', e); }
}
function restaurarSnap() {
  let s = null; try { s = JSON.parse(localStorage.getItem(snapKey()) || 'null'); } catch (e) { }
  if (!s || Date.now() - s.ts > SNAP_MAX_H * 3600e3) return false;
  Object.assign(S, { todas: s.todas, clientes: s.clientes, articulos: s.articulos, bodega: s.bodega, incidencias: s.incidencias, vehiculos: s.vehiculos, personasAll: s.personasAll, paradasTodas: s.paradasTodas, paquetes: s.paquetes, cobros: s.cobros || [], causasCobro: s.causasCobro || [], causasEntrega: s.causasEntrega || [], tiposIncidente: s.tiposIncidente || [], paradas: s.paradas || [], pedidos: s.pedidos || [], lineas: s.lineas || [], sinSenalDesde: s.ts });
  S.rutas = S.todas.filter(r => ['liberada', 'en_ruta', 'cerrada', 'conciliada'].includes(r.estado)); S.reglas = {}; (s.reglas || []).forEach(r => S.reglas[r.clave] = r.valor); S.reglasRaw = s.reglas || [];
  S.ruta = S.rutas.find(r => r.id === s.ruta) || S.rutas.find(r => r.estado === 'en_ruta') || S.rutas.find(r => r.estado === 'liberada') || null;
  return true;
}
const esRed = e => !navigator.onLine || /Failed to fetch|NetworkError|Load failed|network|fetch/i.test(String((e && e.message) || e));
async function load() {
  if (DB.offline) { if (restaurarSnap()) { header(); return; } throw new Error('Sin señal y sin copia reciente de tus rutas en este teléfono. Conéctate una vez para descargarlas.'); }
  try { await loadRed(); S.sinSenalDesde = null; guardarSnap(); }
  catch (e) { if (esRed(e) && restaurarSnap()) { header(); return; } throw e; }
}
async function loadRed() {
  const [rutas, clientes, articulos, reglas, bod, incidencias, vehiculos, personasAll] = await Promise.all([DB.all('rutas', { conductor: S.conductor.nombre }), DB.all('clientes'), DB.all('articulos'), DB.all('reglas'), DB.all('bodegas'), DB.all('incidencias'), DB.all('vehiculos'), DB.all('personas')]); S.vehiculos = vehiculos; S.personasAll = personasAll;
  S.todas = rutas.filter(r => r.estado !== 'simulada').sort((a, b) => a.codigo.localeCompare(b.codigo)); S.rutas = S.todas.filter(r => ['liberada', 'en_ruta', 'cerrada', 'conciliada'].includes(r.estado)); S.clientes = clientes; S.articulos = articulos; S.bodega = bod.find(b => b.codigo === 'VA') || bod[0]; S.reglas = {}; S.reglasRaw = reglas; reglas.forEach(r => S.reglas[r.clave] = r.valor);
  const ids = new Set(S.todas.map(r => r.id)); S.incidencias = incidencias.filter(i => ids.has(i.ruta_id)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  S.paradasTodas = S.todas.length ? await DB.all('paradas', { ruta_id: S.todas.map(r => r.id) }) : [];
  S.paquetes = S.todas.length ? await DB.all('paquetes', { ruta_id: S.todas.map(r => r.id) }) : [];
  try { S.cobros = S.todas.length ? await DB.all('cobros', { ruta_id: S.todas.map(r => r.id) }) : []; S.causasCobro = await DB.all('causas_no_cobro', null, 'orden'); } catch (e) { S.cobros = S.cobros || []; S.causasCobro = S.causasCobro || []; }
  try { S.causasEntrega = await DB.all('causas_entrega', null, 'orden'); S.tiposIncidente = await DB.all('tipos_incidente', null, 'orden'); } catch (e) { S.causasEntrega = S.causasEntrega || []; S.tiposIncidente = S.tiposIncidente || []; }
  if (S.ruta) S.ruta = S.rutas.find(r => r.id === S.ruta.id) || null;
  if (!S.ruta) S.ruta = S.rutas.find(r => r.estado === 'en_ruta') || S.rutas.find(r => r.estado === 'liberada') || null;
  if (S.ruta) { S.paradas = (await DB.all('paradas', { ruta_id: S.ruta.id })).sort((a, b) => a.secuencia - b.secuencia); S.pedidos = await DB.all('pedidos', { ruta_id: S.ruta.id }); S.lineas = S.pedidos.length ? await DB.all('pedido_lineas', { pedido_id: S.pedidos.map(p => p.id) }) : []; }
}
const cli = id => S.clientes.find(c => c.id === id) || {};
const ped = id => S.pedidos.find(p => p.id === id) || {};
const curStop = () => S.paradas.find(s => ['pendiente', 'en_sitio'].includes(s.estado));
const vehDe = r => S.vehiculos.find(v => v.id === r.vehiculo_id) || {};
const esCamion = r => vehDe(r).tipo === 'camion';
const notif = (canal, destinatario, rol, asunto, mensaje, motivo, extra = {}) => paso({ fn: 'insert', table: 'notificaciones', rows: [Object.assign({ canal, destinatario, rol, asunto, mensaje, motivo, ruta_id: S.ruta ? S.ruta.id : null, estado: 'simulado', created_at: new Date().toISOString() }, extra)] });
const gerenteComercial = () => ((S.personasAll || []).find(p => p.rol === 'gerente_comercial') || {}).nombre || 'Gerente comercial';
/* Aviso segmentado: un WhatsApp por cliente y un Telegram por ejecutivo con sus clientes (K6, G2, G4) */
async function avisarClientes(motivo, txtCliente, txtEjecutivo, paradas, params) {
  const porEj = {};
  for (const s of paradas) { const c = cli(s.cliente_id); const p = ped(s.pedido_id); if (!c.nombre) continue; await notif('whatsapp_cliente', `${c.nombre} · ${c.telefono || ''}`, 'cliente', `DGP · ${p.numero_factura || ''}`, txtCliente(s, c, p), motivo, { cliente_id: c.id || null, parametros: params ? params(s, c, p) : null }); (porEj[c.ejecutivo] = porEj[c.ejecutivo] || []).push(`${c.nombre} ${s.eta}`); }
  for (const [ej, l] of Object.entries(porEj)) await notif('telegram', ej, 'ejecutivo', `${S.ruta.codigo} · ${motivo}`, txtEjecutivo(l), motivo);
  if (motivo.startsWith('demora')) await notif('telegram', gerenteComercial(), 'gerente_comercial', `${S.ruta.codigo} · ${motivo}`, txtEjecutivo(Object.values(porEj).flat()), motivo);
}
async function prepArea(r) { r.area_cargue_at = new Date().toISOString(); await paso({ fn: 'update', table: 'rutas', match: { id: r.id }, patch: { area_cargue_at: r.area_cargue_at } }); S.ruta = r; await evento('area_cargue', `Revisé ${S.paquetes.filter(q => q.ruta_id === r.id).length} facturas, color ${r.color_nombre || ''}: mercancía en el área de cargue`); S.ruta = null; toast('Mercancía en área de cargue'); render(); }
async function prepLlamar(r) {
  r.verificador_llamado_at = new Date().toISOString(); await paso({ fn: 'update', table: 'rutas', match: { id: r.id }, patch: { verificador_llamado_at: r.verificador_llamado_at } });
  const ver = (S.personasAll || []).filter(p => p.rol === 'verificador').map(p => p.nombre); S.ruta = r;
  for (const v of ver) await notif('telegram', v, 'verificador', `${r.codigo} lista para verificar`, `${S.conductor.nombre} espera en el área de cargue con ${S.paquetes.filter(q => q.ruta_id === r.id).length} facturas (${r.color_nombre || ''}). Lleva los paquetes impresos.`, 'llamado al verificador (paso 4)');
  await paso({ fn: 'insert', table: 'alertas', rows: [{ tipo: 'verificacion', severidad: 'media', titulo: `${r.codigo}: el conductor llama al verificador`, detalle: `${S.conductor.nombre} en el área de cargue · ${r.color_nombre || ''}`, entidad: 'ruta', destinatario: ver.join(', '), created_at: new Date().toISOString() }] });
  await evento('llamado_verificador', '¡Vamos a verificar la salida de la mercancía!'); S.ruta = null; toast('Verificador avisado'); render();
}
// -------- acciones --------
async function salida() {
  const odo = +$('f-odo').value || 0; if (PROD && !odo) { toast('Escribe la lectura del odómetro'); $('f-odo').focus(); return; } const comb = $('f-comb').value; const chk = [...document.querySelectorAll('[data-chk]:checked')].length;
  const salidaAt = new Date().toISOString();
  await paso({ fn: 'update', table: 'rutas', match: { id: S.ruta.id }, patch: { estado: 'en_ruta', salida_at: salidaAt, odometro_salida: odo } });
  S.ruta.estado = 'en_ruta'; S.ruta.salida_at = salidaAt; S.ruta.odometro_salida = odo;
  const pal = $('f-pal') ? +$('f-pal').value || null : null; if (pal != null) { S.ruta.pallets_salida = pal; await paso({ fn: 'update', table: 'rutas', match: { id: S.ruta.id }, patch: { pallets_salida: pal } }); }
  await evento('salida', `Salida de bodega · odómetro ${odo.toLocaleString('es-PA')} km · combustible ${comb} · inspección ${chk}/5 OK${pal != null ? ' · ' + pal + ' pallets' : ''}`, { detalle: { odometro: odo, combustible: comb, checklist: chk, pallets: pal } });
  const hs = new Date(S.ruta.salida_at).toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit' });
  await avisarClientes('salida de ruta (K6)', (s, c, p) => `DGP: su pedido ${p.numero_factura} salió de nuestra bodega a las ${hs} en la ruta ${S.ruta.codigo}. Llegada estimada: ${s.eta}${c.ventana_inicio ? ' (su horario ' + c.ventana_inicio + '–' + c.ventana_fin + ')' : ''}.`, l => `${S.ruta.codigo} salió a las ${hs} con ${S.conductor.nombre}. Tus clientes (ETA): ${l.join('; ')}.`, S.paradas.filter(x => x.tipo === 'entrega'), (s, c, p) => [p.numero_factura || p.numero_so, hs, s.eta]);
  S.screen = 'ruta'; toast('Salida registrada'); render(); startPing();
}
async function checkin(s) {
  const p = await geo(); const c = s.cliente_id ? cli(s.cliente_id) : { lat: s.lat, lng: s.lng }; const dist = p.lat == null ? 99999 : Math.round(GEO.metros(p, { lat: +s.lat, lng: +s.lng }));
  if (p.lat == null) toast('Sin GPS: activa la ubicación del teléfono. El check-in queda marcado para revisión.');
  // Dirección con coordenada aproximada (centro del barrio): el radio normal daría «fuera del radio» en la puerta del cliente.
  // Al entregar, este GPS pasa a ser la coordenada exacta de la dirección (trigger gps_entrega en la base).
  const pd = s.pedido_id ? ped(s.pedido_id) : null; const aprox = !!pd && !!pd.direccion_id && !['validada', 'automatica'].includes(pd.entrega_geo_estado);
  const radio = aprox ? (+(S.reglas.checkin_radio_aproximada || {}).metros || 3000) : (+(S.reglas.checkin_radio || {}).metros || 150);
  const ci = { estado: 'en_sitio', checkin_at: new Date().toISOString(), checkin_lat: p.lat, checkin_lng: p.lng, distancia_checkin_m: p.lat == null ? null : dist };
  await paso({ fn: 'update', table: 'paradas', match: { id: s.id }, patch: ci }); Object.assign(s, ci);
  await evento('checkin', `Check-in ${s.tipo === 'entrega' ? c.nombre : s.tipo} · ${p.lat == null ? 'SIN GPS' : `a ${dist} m del punto`}${p.real || p.lat == null ? '' : ' (GPS simulado)'}${dist > radio ? ' · FUERA DEL RADIO ' + radio + ' m' : ''}${aprox && p.lat != null ? ' · dirección aproximada: este GPS fija la ubicación al entregar' : ''}`, { parada_id: s.id, detalle: { distancia_m: p.lat == null ? null : dist, gps: p.real ? 'telefono' : p.lat == null ? 'sin_gps' : 'simulado', direccion_aproximada: aprox } }, p);
  if (dist > radio) { await paso({ fn: 'insert', table: 'alertas', rows: [{ tipo: 'checkin', severidad: 'media', titulo: p.lat == null ? `${S.ruta.codigo}: check-in SIN GPS en ${c.nombre || s.tipo}` : `${S.ruta.codigo}: check-in a ${dist} m de ${c.nombre || s.tipo}`, detalle: `Radio permitido ${radio} m. Verificar ubicación del cliente en CRM.`, entidad: 'parada', destinatario: 'Torre de control', created_at: new Date().toISOString() }] }); toast(`Check-in a ${dist} m: fuera del radio permitido`); } else toast(`Check-in OK · ${dist} m`);
  render();
}
async function cerrarParada(s, resultado) {
  const c = cli(s.cliente_id); const p = ped(s.pedido_id); const now = new Date().toISOString();
  const patch = { estado: resultado === 'total' ? 'atendida' : resultado === 'parcial' ? 'parcial' : 'no_entregada', checkout_at: now };
  let texto = ''; const lineas = [];
  const fotos = S.form.fotos || []; if (fotos.length) { patch.fotos = fotos; patch.foto = fotos[0]; }
  if (resultado !== 'no') { const rec = $('f-rec').value.trim(); if (rec.length < 2) { toast('Escribe el nombre de quien recibe'); $('f-rec').focus(); return; } patch.receptor = rec; patch.firma = S.form.firma || null; }
  let causaSel = null, notaC = '';
  if (resultado !== 'total') { const k = resultado === 'parcial' ? 'p' : 'n'; causaSel = causasEntregaPara(S.causasEntrega, resultado === 'parcial' ? 'parcial' : 'no_entrega').find(x => x.codigo === $('f-causa-' + k).value); notaC = $('f-nota-' + k).value.trim();
    if (!causaSel) { toast(`Elige la causa de la ${resultado === 'parcial' ? 'entrega parcial' : 'no entrega'}`); $('f-causa-' + k).focus(); return; }
    if (causaSel.requiere_nota && notaC.length < 3) { toast(`La causa «${causaSel.nombre}» requiere una nota`); $('f-nota-' + k).focus(); return; } }
  const causaTxt = causaSel ? causaSel.nombre + (notaC ? ` (${notaC})` : '') : '';
  if (resultado === 'total') { patch.resultado = 'Entrega total'; texto = `Entrega total ${p.numero_factura} · recibe ${patch.receptor} · firma${patch.foto ? ' + foto' : ''}`; }
  if (resultado === 'parcial') {
    const q = [...document.querySelectorAll('[data-q]')].map(i => ({ sku: i.dataset.q, txt: i.value.trim(), ent: Number(i.value), req: +i.dataset.req }));
    // DATA-001: cantidades enteras entre 0 y lo requerido; si no, no se envía nada y el formulario queda como está
    const mal = q.filter(x => x.txt === '' || !Number.isInteger(x.ent) || x.ent < 0 || x.ent > x.req);
    if (mal.length) { toast(`Revisa las cantidades de ${mal.map(x => x.sku).join(', ')}: entre 0 y lo requerido`); const el = document.querySelector(`[data-q="${mal[0].sku}"]`); if (el) el.focus(); return; }
    const falt = q.filter(x => x.ent < x.req); if (!falt.length) { toast('Todas las cantidades están completas: registra entrega total'); return; }
    const causa = causaTxt; patch.resultado = `Parcial · ${causa} · faltan ${falt.map(x => x.sku + ' ' + (x.req - x.ent)).join(', ')}`; texto = `Entrega PARCIAL ${p.numero_factura} · ${falt.map(x => `${x.sku} ${x.ent}/${x.req}`).join(', ')} · causa: ${causa} · devolución generada · firma + foto`;
    for (const x of q) { const l = S.lineas.find(l => l.pedido_id === p.id && l.sku === x.sku); if (l) lineas.push({ id: l.id, entregado: x.ent }); }
  }
  if (resultado === 'no') { const causa = causaTxt; patch.resultado = `No entregada · ${causa}`; texto = `NO ENTREGADA ${p.numero_factura} · causa: ${causa} · reprogramación solicitada`; }
  // parada + pedido + líneas en una sola operación atómica; el estado local cambia solo si se guardó o quedó en cola
  await paso({ fn: 'rpc', name: 'registrar_entrega', args: { parada: s.id, resultado, datos: patch, lineas } });
  Object.assign(s, patch); if (p.id) p.estado = resultado === 'total' ? 'entregado' : resultado === 'parcial' ? 'parcial' : 'no_entregado';
  for (const x of lineas) { const l = S.lineas.find(l => l.id === x.id); if (l) l.entregado = x.entregado; }
  await evento(resultado === 'total' ? 'entrega' : resultado === 'parcial' ? 'entrega_parcial' : 'no_entrega', texto, { parada_id: s.id, detalle: { factura: p.numero_factura, receptor: patch.receptor, causa_codigo: causaSel ? causaSel.codigo : null, causa: causaSel ? causaSel.nombre : null, nota: notaC || null, evidencia: { firma: !!patch.firma, foto: !!patch.foto } } });
  if (resultado !== 'total') await paso({ fn: 'insert', table: 'alertas', rows: [{ tipo: resultado === 'parcial' ? 'parcial' : 'no_entrega', severidad: resultado === 'parcial' ? 'media' : 'alta', titulo: `${S.ruta.codigo} · ${c.nombre}: ${resultado === 'parcial' ? 'entrega parcial' : 'no entregada'}`, detalle: `${p.numero_factura}: ${patch.resultado}. Acción para ${c.ejecutivo}. RF-045.`, entidad: 'parada', destinatario: c.ejecutivo, created_at: now }] });
  S.form = {}; toast(patch.resultado); render();
}
/* Parada de servicio (sin factura): el conductor o el técnico la cierra como realizada o no realizada. */
async function cerrarServicio(s, ok) {
  const rec = ($('f-srec').value || '').trim(); const nota = ($('f-snota').value || '').trim(); const c = cli(s.cliente_id);
  if (ok && rec.length < 2) { toast('Escribe quién recibió el servicio'); $('f-srec').focus(); return; }
  if (!ok && nota.length < 3) { toast('Explica por qué no se pudo realizar'); $('f-snota').focus(); return; }
  const now = new Date().toISOString(); const fotos = S.form.fotos || [];
  const patch = { estado: ok ? 'atendida' : 'no_entregada', checkout_at: now, resultado: `${ok ? 'Servicio realizado' : 'Servicio NO realizado'}${nota ? ' · ' + nota : ''}`, receptor: ok ? rec : null, firma: ok ? (S.form.firma || null) : null };
  if (fotos.length) { patch.fotos = fotos; patch.foto = fotos[0]; }
  await paso({ fn: 'update', table: 'paradas', match: { id: s.id }, patch }); Object.assign(s, patch);
  await evento(ok ? 'servicio' : 'servicio_no_realizado', `${ok ? 'SERVICIO realizado' : 'SERVICIO NO realizado'} en ${c.nombre || ''}${ok ? ' · atendió ' + rec : ''}${nota ? ' · ' + nota : ''}`, { parada_id: s.id, detalle: { servicio: (s.notas || '').slice(0, 120), receptor: ok ? rec : null, firma: !!patch.firma, fotos: fotos.length } });
  if (!ok) await paso({ fn: 'insert', table: 'alertas', rows: [{ tipo: 'servicio', severidad: 'media', titulo: `${S.ruta.codigo} · ${c.nombre || ''}: servicio no realizado`, detalle: `${nota}. ${(s.notas || '').slice(0, 160)}`, entidad: 'ruta', destinatario: 'Operaciones', created_at: now }] });
  S.form = {}; toast(ok ? 'Servicio registrado' : 'Servicio marcado como no realizado'); render();
}
async function terminarParada(s) { const now = new Date().toISOString(); const fin = { estado: 'atendida', checkout_at: now, resultado: s.tipo === 'almuerzo' ? 'Almuerzo' : 'Compra registrada', foto: S.form.foto || null }; await paso({ fn: 'update', table: 'paradas', match: { id: s.id }, patch: fin }); Object.assign(s, fin); await evento(s.tipo, s.tipo === 'almuerzo' ? 'Fin de almuerzo del equipo' : 'Compra registrada con factura del proveedor (foto) · dispensadores para ruta', { parada_id: s.id }); S.form = {}; render(); }
async function demora() {
  const min = +prompt('Minutos de demora', '45') || 0; if (!min) return; const motivo = prompt('Motivo', 'Tráfico en Corredor Sur') || 'Demora';
  const pend = S.paradas.filter(s => s.estado === 'pendiente'); for (const s of pend) { s.eta = hhmm(tmin(s.eta) + min); await paso({ fn: 'update', table: 'paradas', match: { id: s.id }, patch: { eta: s.eta } }); }
  S.ruta.version = (+S.ruta.version || 1) + 1; await paso({ fn: 'update', table: 'rutas', match: { id: S.ruta.id }, patch: { version: S.ruta.version, hora_fin_prevista: hhmm(tmin(S.ruta.hora_fin_prevista) + min) } });
  const filaDem = { id: DB.uuid(), ruta_id: S.ruta.id, parada_id: (curStop() || {}).id || null, tipo: 'demora', descripcion: motivo, demora_min: min, estado: 'notificada', actor: S.conductor.nombre, created_at: new Date().toISOString() };
  await paso({ fn: 'insert', table: 'incidencias', rows: [filaDem] }); S.incidencias.unshift(filaDem);   // la lista de la app se actualiza al momento (antes solo al recargar)
  await avisarClientes('demora: nueva hora de llegada (K6)', (s, c, p) => `DGP: su pedido ${p.numero_factura} llegará con retraso por ${motivo.toLowerCase()}. Nueva hora estimada: ${s.eta}. Disculpe la molestia.`, l => `${S.ruta.codigo}: demora de ${min} min (${motivo}). Nuevas ETA: ${l.join('; ')}.`, pend.filter(x => x.tipo === 'entrega'), (s, c, p) => [p.numero_factura || p.numero_so, motivo.toLowerCase(), s.eta]);
  await evento('demora', `INCIDENTE demora ${min} min (${motivo}) · ETA recalculadas para ${pend.length} paradas · versión ${S.ruta.version}`, { detalle: { minutos: min, motivo, paradas: pend.length } });
  await paso({ fn: 'insert', table: 'alertas', rows: [{ tipo: 'demora', severidad: 'media', titulo: `${S.ruta.codigo}: demora de ${min} min reportada por ${S.conductor.nombre}`, detalle: `${motivo}. ETA recalculadas para ${pend.length} paradas · versión ${S.ruta.version} conservada con historial · clientes y ejecutivos notificados. RF-025/062.`, entidad: 'ruta', destinatario: 'Ejecutivos', created_at: new Date().toISOString() }] });
  toast(`Demora registrada · ETA +${min} min`); render();
}
function incidente() {   // hoja con el catálogo de tipos de incidente, descripción y foto
  const tipos = tiposIncidenteActivos(S.tiposIncidente); S.inc = { foto: null };
  hoja(`<h2 style="margin:0 0 6px">Reportar incidente</h2><label>Tipo de incidente *</label><select id="i-tipo"><option value="">— Elegir —</option>${tipos.map(t => `<option value="${esc(t.codigo)}">${esc(t.nombre)}</option>`).join('')}</select>
    <label>¿Qué pasó?</label><textarea id="i-desc" rows="3" maxlength="400" placeholder="Describe lo ocurrido, dónde estás y si necesitas ayuda"></textarea>
    <label>Foto (opcional)</label>${fotoBotones('inc')}<img class="foto" id="i-foto" alt="">
    <div class="row" style="margin-top:10px"><button class="big sec" id="i-x">Cancelar</button><button class="big crit" id="i-ok">Reportar</button></div>`);
  fotoEventos(); $('i-x').onclick = cerrarHoja; $('i-ok').onclick = () => incidenteGuardar();
}
async function incidenteGuardar() {
  const t = tiposIncidenteActivos(S.tiposIncidente).find(x => x.codigo === $('i-tipo').value); const d = $('i-desc').value.trim();
  if (!t) { toast('Elige el tipo de incidente'); $('i-tipo').focus(); return; }
  if (t.requiere_nota && d.length < 3) { toast(`Describe lo ocurrido (obligatorio en «${t.nombre}»)`); $('i-desc').focus(); return; }
  const foto = S.inc && S.inc.foto || null; $('i-ok').disabled = true; const desc = d || t.nombre;
  const filaInc = { id: DB.uuid(), ruta_id: S.ruta.id, parada_id: (curStop() || {}).id || null, tipo: t.codigo, descripcion: desc, foto, estado: 'registrada', actor: S.conductor.nombre, created_at: new Date().toISOString() };
  await paso({ fn: 'insert', table: 'incidencias', rows: [filaInc] }); S.incidencias.unshift(filaInc);
  await evento('incidente', `INCIDENTE ${t.nombre}: ${desc}${foto ? ' · con foto' : ''}`, { detalle: { tipo: t.codigo, tipo_nombre: t.nombre, descripcion: desc, foto: !!foto } });
  await paso({ fn: 'insert', table: 'alertas', rows: [{ tipo: 'incidente', severidad: t.severidad || 'media', titulo: `${S.ruta.codigo}: ${t.nombre} · ${S.conductor.nombre}`, detalle: `${desc} · Aviso a ${t.avisar_a || 'Operaciones'}. RF-047.`, entidad: 'ruta', destinatario: t.avisar_a || 'Operaciones', created_at: new Date().toISOString() }] });
  S.inc = null; cerrarHoja(); toast('Incidente reportado'); render();
}
async function combustible() { const l = +prompt('Litros', '38') || 0; if (!l) return; const c = +prompt('Costo B/.', (l * 0.98).toFixed(2)) || 0; const odo = +prompt('Odómetro km', String((+S.ruta.odometro_salida || 48212) + 40)) || 0; await paso({ fn: 'insert', table: 'abastecimientos', rows: [{ ruta_id: S.ruta.id, vehiculo_id: S.ruta.vehiculo_id, estacion: 'Terpel Costa del Este', litros: l, costo: c, odometro_km: odo, foto: S.form.foto || null, fecha: new Date().toISOString() }] }); await evento('combustible', `Abastecimiento ${l} L · B/. ${fmt(c)} · odómetro ${odo} · foto del recibo`, { detalle: { litros: l, costo: c, odometro: odo } }); toast('Abastecimiento registrado'); render(); }
async function llegada() {
  // Odómetro de llegada OBLIGATORIO para cerrar la ruta (entero, mayor que cero y no menor que el de salida). Se valida antes de guardar nada.
  const fo = $('f-odo2'); const odoTxt = (fo.value || '').trim(); const odoN = Number(odoTxt); const sal = +S.ruta.odometro_salida || 0;
  fo.classList.remove('campo-error');
  if (!odoTxt || !Number.isInteger(odoN) || odoN <= 0) { fo.classList.add('campo-error'); toast('El odómetro de llegada es obligatorio para cerrar la ruta'); fo.focus(); return; }
  if (sal && odoN < sal) { fo.classList.add('campo-error'); toast(`El odómetro de llegada (${odoN.toLocaleString('es-PA')}) no puede ser menor que el de salida (${sal.toLocaleString('es-PA')})`); fo.focus(); return; }
  if (sal && odoN - sal > 800 && !confirm(`Recorrido de ${(odoN - sal).toLocaleString('es-PA')} km en esta ruta. ¿La lectura ${odoN.toLocaleString('es-PA')} es correcta?`)) { fo.focus(); return; }
  const cp = cobrosDe(S.ruta).filter(c => c.estado === 'pendiente'); if (cp.length && !confirm(`Tienes ${cp.length} cobro${cp.length === 1 ? '' : 's'} sin marcar (recibido o no recibido). Puedes marcarlos después, pero ¿registrar la llegada ahora?`)) return; if ($('f-palr')) { const pr = $('f-palr').value === '' ? null : +$('f-palr').value; const pb = $('f-palb').checked; S.ruta.pallets_retorno = pr; S.ruta.pallets_buen_estado = pb; await paso({ fn: 'update', table: 'rutas', match: { id: S.ruta.id }, patch: { pallets_retorno: pr, pallets_buen_estado: pb } }); }
  const odo = odoN; const now = new Date().toISOString(); const cierre = { estado: 'cerrada', llegada_at: now, odometro_llegada: odo, km_real: odo && S.ruta.odometro_salida ? odo - S.ruta.odometro_salida : null }; await paso({ fn: 'update', table: 'rutas', match: { id: S.ruta.id }, patch: cierre }); Object.assign(S.ruta, cierre); await evento('llegada', `Llegada a bodega · odómetro ${odo.toLocaleString('es-PA')} km · ${S.paradas.filter(s => s.estado === 'parcial' || s.estado === 'no_entregada').length} devoluciones entregadas a bodega · ${S.incidencias.filter(i => i.ruta_id === S.ruta.id).length} incidencias`, { detalle: { odometro: odo, incidencias: S.incidencias.filter(i => i.ruta_id === S.ruta.id).length } }); stopPing(); toast('Ruta cerrada');
  try { if (DB.getMode() === 'supabase' && Q.online()) { await Q.flush(); await load(); } } catch (e) { }   // el resumen de cierre se pinta con lo que hay en la base
  render(); }
let pingT = null; function startPing() { stopPing(); pingT = setInterval(async () => { if (!S.ruta || S.ruta.estado !== 'en_ruta') return; const p = await geo(true); if (p.lat == null) return; Q.push({ fn: 'insert', table: 'posiciones', rows: [{ ruta_id: S.ruta.id, lat: p.lat, lng: p.lng, velocidad: p.real ? null : 24, ts: new Date().toISOString() }] }); }, 30000); } function stopPing() { if (pingT) clearInterval(pingT); pingT = null; }
// -------- cobros en ruta --------
const tipoInc = c => ((S.tiposIncidente && S.tiposIncidente.length) ? S.tiposIncidente : TI_DEF).find(x => x.codigo === c);
const cobrosDe = r => (S.cobros || []).filter(c => c.ruta_id === r.id && c.estado !== 'anulado');
/* Tarjeta de cobros del viaje. editable = el conductor puede marcar Recibido / No recibido (en ruta o ruta cerrada, antes de entregar en oficina). */
function cobrosHtml(r, editable) {
  const cs = cobrosDe(r); if (!cs.length) return '';
  const tot = cs.reduce((a, c) => a + +c.monto, 0); const pend = cs.filter(c => c.estado === 'pendiente').length; const F = S.form.cobro;
  return `<div class="card"><h2 style="margin:0 0 2px">Cobros de este viaje</h2><p class="mini" style="margin:0 0 6px">${cs.length} cobro${cs.length === 1 ? '' : 's'} · B/. ${fmt(tot)}${pend ? ` · <b>${pend} por gestionar</b>` : ''}. Guarda el efectivo y los cheques: al regresar los entregas en la oficina con firma.</p>
  ${cs.map(c => { const k = cli(c.cliente_id); const abierto = editable && ['pendiente', 'recibido', 'no_recibido'].includes(c.estado);
    let h = `<div class="q" style="grid-template-columns:1fr auto"><span><b>${esc(k.nombre || 'Cliente')}</b><br><span class="mini">${esc(c.documento || 'sin documento')} · ${esc(cbForma(c))}</span>${c.notas ? `<br><span class="mini">📝 ${esc(c.notas)}</span>` : ''}</span><span style="text-align:right"><b>B/. ${fmt(c.monto)}</b><br>${cbPill(c.estado)}</span></div>`;
    if (c.estado === 'recibido' || c.estado === 'entregado') h += `<div class="mini">Recibido B/. ${fmt(c.monto_recibido)}${c.estado === 'entregado' ? ` · entregado a ${esc(c.entregado_a || '')}` : ''}${c.nota_conductor ? ' · ' + esc(c.nota_conductor) : ''}</div>`;
    if (c.estado === 'no_recibido') h += `<div class="mini">No recibido: ${esc(c.causa_nombre || '')}${c.nota_conductor ? ' · ' + esc(c.nota_conductor) : ''}</div>`;
    if (abierto && F && F.id === c.id) {
      h += F.modo === 'si' ? `<label>Monto recibido B/.</label><input id="cob-m" type="number" inputmode="decimal" step="0.01" min="0.01" value="${(+(c.monto_recibido || c.monto)).toFixed(2)}">${c.forma === 'cheque' ? `<p class="mini" style="margin:4px 0">Revisa el cheque: ${esc(c.banco || '')} nº ${esc(c.numero_cheque || '')}, monto, fecha, beneficiario y firma.</p>` : ''}<label>Nota (obligatoria si el monto es distinto)</label><input id="cob-n" maxlength="200">`
        : `<label>¿Por qué no se recibió?</label><select id="cob-c"><option value="">— Elegir causa —</option>${cbCausas(S.causasCobro).map(x => `<option value="${esc(x.codigo)}">${esc(x.nombre)}</option>`).join('')}</select><label>Nota</label><input id="cob-n" maxlength="200" placeholder="Obligatoria en algunas causas">`;
      h += `<div class="row"><button class="big sec" data-cob-x>Cancelar</button><button class="big ${F.modo === 'si' ? '' : 'crit'}" data-cob-ok="${c.id}">${F.modo === 'si' ? 'Confirmar recibido' : 'Confirmar no recibido'}</button></div>`;
    } else if (abierto && c.estado === 'pendiente') h += `<div class="row"><button class="big" data-cob-si="${c.id}" style="padding:8px">Recibido</button><button class="big crit" data-cob-no="${c.id}" style="padding:8px">No recibido</button></div>`;
    else if (abierto) h += `<div class="mini" style="margin-top:4px">¿Te equivocaste? <a href="#" data-cob-${c.estado === 'recibido' ? 'si' : 'no'}="${c.id}">corregir monto/nota</a> · <a href="#" data-cob-${c.estado === 'recibido' ? 'no' : 'si'}="${c.id}">cambiar a ${c.estado === 'recibido' ? 'no recibido' : 'recibido'}</a></div>`;
    return `<div style="border-bottom:1px solid var(--line);padding-bottom:6px;margin-bottom:6px">${h}</div>`; }).join('')}</div>`;
}
function cobrosEventos() {
  document.querySelectorAll('[data-cob-si]').forEach(b => b.onclick = e => { e.preventDefault(); S.form.cobro = { id: b.dataset.cobSi, modo: 'si' }; render(); });
  document.querySelectorAll('[data-cob-no]').forEach(b => b.onclick = e => { e.preventDefault(); S.form.cobro = { id: b.dataset.cobNo, modo: 'no' }; render(); });
  document.querySelectorAll('[data-cob-x]').forEach(b => b.onclick = () => { S.form.cobro = null; render(); });
  document.querySelectorAll('[data-cob-ok]').forEach(b => b.onclick = () => cobroGuardar(b.dataset.cobOk));
}
async function cobroGuardar(id) {
  const c = (S.cobros || []).find(x => x.id === id); const F = S.form.cobro; if (!c || !F) return; const r = S.todas.find(x => x.id === c.ruta_id) || S.ruta;
  const si = F.modo === 'si'; const nota = ($('cob-n') ? $('cob-n').value : '').trim(); const m = si ? Math.round(+$('cob-m').value * 100) / 100 : null; const causa = si ? null : $('cob-c').value;
  // mismas validaciones que la base, para no encolar algo que se rechazará
  if (si && !(m > 0)) { toast('Escribe el monto recibido'); $('cob-m').focus(); return; }
  if (si && Math.abs(m - +c.monto) > 0.004 && nota.length < 3) { toast(`Recibiste B/. ${fmt(m)} y el cobro es B/. ${fmt(c.monto)}: explica la diferencia en la nota`); $('cob-n').focus(); return; }
  const ca = si ? null : cbCausas(S.causasCobro).find(x => x.codigo === causa);
  if (!si && !ca) { toast('Elige la causa'); $('cob-c').focus(); return; }
  if (!si && ca.requiere_nota && nota.length < 3) { toast(`La causa «${ca.nombre}» requiere una nota`); $('cob-n').focus(); return; }
  const p = await geo(true); const args = { cid: c.id, recibido: si, monto_recibido: m, causa, nota: nota || null, lat: p.lat, lng: p.lng };
  if (DB.getMode() === 'supabase') {
    await paso({ fn: 'rpc', name: 'registrar_cobro', args });
    Object.assign(c, si ? { estado: 'recibido', monto_recibido: m, causa_codigo: null, causa_nombre: null } : { estado: 'no_recibido', monto_recibido: null, causa_codigo: ca.codigo, causa_nombre: ca.nombre }, { nota_conductor: nota || null, gestion_at: new Date().toISOString(), conductor: S.conductor.nombre });
  } else { try { await cbRegistrarLocal(c, r, Object.assign({}, args), S.causasCobro, S.conductor.nombre); } catch (e) { toast(e.message || String(e)); return; } }
  await evento(si ? 'cobro_recibido' : 'cobro_no_recibido', `${si ? 'Cobro RECIBIDO' : 'Cobro NO recibido'} · ${cli(c.cliente_id).nombre || ''} · B/. ${fmt(si ? m : c.monto)} ${cbForma(c)}${ca ? ' · causa: ' + ca.nombre : ''}${nota ? ' · ' + nota : ''}`, { detalle: { cobro_id: c.id } }, p);
  S.form.cobro = null; toast(si ? `Cobro recibido · B/. ${fmt(m)}` : 'Cobro marcado como no recibido'); render();
}
// -------- firma y foto --------
function initSig() { const c = document.querySelector('canvas.sig'); if (!c) return; const ctx = c.getContext('2d'); c.width = c.offsetWidth * 2; c.height = 280; ctx.scale(2, 2); ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#0F172A'; let d = false; const pos = e => { const r = c.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return [t.clientX - r.left, t.clientY - r.top]; };
  const down = e => { d = true; ctx.beginPath(); ctx.moveTo(...pos(e)); e.preventDefault(); }, move = e => { if (!d) return; ctx.lineTo(...pos(e)); ctx.stroke(); S.form.firma = c.toDataURL('image/png'); e.preventDefault(); }, up = () => d = false;
  c.addEventListener('pointerdown', down); c.addEventListener('pointermove', move); window.addEventListener('pointerup', up); }
/* Dos botones: «Tomar foto» abre la cámara dentro de la app (getUserMedia); «Subir archivo» abre la galería / archivos.
   Si el navegador no deja usar la cámara, «Tomar foto» abre la cámara del teléfono (input capture). destino: '' = formulario, 'inc' = incidente. */
const fotoBotones = (destino = '') => `<div class="row foto-btns"><button type="button" class="big info" data-foto-cam="${destino}" style="padding:10px">📷 Tomar foto</button><label class="big sec" style="padding:10px;cursor:pointer">🖼 Subir archivo<input type="file" accept="image/*" data-foto-file="${destino}" hidden></label></div>`;
function fotoEventos() {
  document.querySelectorAll('[data-foto-cam]').forEach(b => b.onclick = () => tomarFoto(b.dataset.fotoCam));
  document.querySelectorAll('[data-foto-file]').forEach(i => i.onchange = () => foto(i, i.dataset.fotoFile));
}
function fotoComprimir(src, cb) { const img = new Image(); img.onload = () => { const cv = document.createElement('canvas'); const k = Math.min(1, 1024 / Math.max(img.width, img.height)); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k); cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height); cb(cv.toDataURL('image/jpeg', .62)); }; img.onerror = () => toast('No se pudo leer la imagen'); img.src = src; }
function agregarFoto(dataUrl, destino) {
  if (destino === 'inc') { S.inc = S.inc || {}; S.inc.foto = dataUrl; const el = $('i-foto'); if (el) { el.src = dataUrl; el.style.display = 'block'; } toast('Foto adjuntada'); return; }
  S.form.foto = dataUrl; const el = document.querySelector('.foto:not(#i-foto)'); if (el) { el.src = dataUrl; el.style.display = 'block'; }
  const max = (S.reglas.fotos_entrega || {}).maximo || 3; const box = $('fotos');
  if (box) { S.form.fotos = (S.form.fotos || []).concat([dataUrl]).slice(-max); box.innerHTML = S.form.fotos.map(x => `<img src="${x}" alt="">`).join(''); }
  toast(`Foto adjuntada${box ? ' (' + S.form.fotos.length + '/' + max + ')' : ''}`);
}
function foto(input, destino = '') { const f = input.files[0]; if (!f) return; const u = URL.createObjectURL(f); fotoComprimir(u, d => { URL.revokeObjectURL(u); agregarFoto(d, destino); }); input.value = ''; }
function fotoCapturaNativa(destino) { const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.setAttribute('capture', 'environment'); i.onchange = () => foto(i, destino); i.click(); }
async function tomarFoto(destino = '') {
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return fotoCapturaNativa(destino);
  let stream; try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }); }
  catch (e) { toast(e && e.name === 'NotAllowedError' ? 'Permite el uso de la cámara para esta página (o usa «Subir archivo»)' : 'No se pudo abrir la cámara: se abre la del teléfono'); if (!(e && e.name === 'NotAllowedError')) fotoCapturaNativa(destino); return; }
  const ov = document.createElement('div'); ov.id = 'cam-ov';
  ov.innerHTML = `<video autoplay playsinline muted></video><div class="cam-bar"><button class="big sec" data-c="x">Cancelar</button><button class="big" data-c="ok">● Capturar</button></div>`;
  document.body.appendChild(ov); const v = ov.querySelector('video'); v.srcObject = stream;
  const cerrar = () => { stream.getTracks().forEach(t => t.stop()); ov.remove(); };
  ov.querySelector('[data-c=x]').onclick = cerrar;
  ov.querySelector('[data-c=ok]').onclick = () => { if (!v.videoWidth) return toast('La cámara aún no está lista'); const cv = document.createElement('canvas'); cv.width = v.videoWidth; cv.height = v.videoHeight; cv.getContext('2d').drawImage(v, 0, 0); cerrar(); fotoComprimir(cv.toDataURL('image/jpeg', .9), d => agregarFoto(d, destino)); };
}
function hoja(html) { cerrarHoja(); const h = document.createElement('div'); h.id = 'hoja'; h.innerHTML = `<div class="hoja-in card">${html}</div>`; h.onclick = e => { if (e.target === h) cerrarHoja(); }; document.body.appendChild(h); }
function cerrarHoja() { const h = $('hoja'); if (h) h.remove(); }
// -------- preparación de salida (infografía, pasos 3 y 4) --------
function prepHtml(r) {
  const q = S.paquetes.filter(x => x.ruta_id === r.id); const fir = q.filter(x => ['firmado', 'registrado', 'en_bodega', 'entregado_gd'].includes(x.estado)).length; const ver = q.filter(x => x.estado !== 'pendiente' && ['verificado', 'firmado', 'registrado', 'en_bodega', 'entregado_gd'].includes(x.estado)).length;
  const col = r.color || '#64748B'; const h = (col.replace('#', '')); const n = parseInt(h, 16); const claro = ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 > 160;
  return `<div style="background:${col};color:${claro ? '#0F172A' : '#fff'};border-radius:12px;padding:12px;margin-top:10px"><div style="font-size:22px;font-weight:800;letter-spacing:.02em">${esc((r.color_nombre || '').toUpperCase())}</div><div style="font-size:13px">Tu color de ruta · ${q.length} facturas · ${r.cajas || 0} cajas</div></div>
  <div class="kv" style="margin-top:8px"><b>Paquetes impresos</b><span>${q.filter(x => x.impreso_at).length}/${q.length}</span><b>Verificados</b><span>${ver}/${q.length}</span><b>Firmados</b><span>${fir}/${q.length}</span></div>
  ${!r.area_cargue_at ? `<p class="mini" style="margin:8px 0 0">Revisa la cantidad de facturas, identifica el color de tu ruta y lleva la mercancía al área de cargue.</p><button class="big" data-area="${r.id}">Mercancía en el área de cargue</button>` : !r.verificador_llamado_at ? `<button class="big info" data-llamar="${r.id}">Llamar al verificador</button>` : `<p class="mini" style="margin:8px 0 0">Verificador llamado a las ${new Date(r.verificador_llamado_at).toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit' })}. Dicta los artículos y cantidades de cada factura; al final firman los dos. La ruta se libera cuando todo esté firmado y registrado en Books.</p>`}`;
}
// -------- render --------
function header() { const q = Q.list().length; const on = Q.online(); const dz = Q.dead().length; $('hd-st').innerHTML = `<i></i>${on ? 'En línea' : 'Sin señal'}${q ? ' · ' + q + ' en cola' : ''}${dz ? ' · ' + dz + ' sin sincronizar' : ''}${S.sinSenalDesde ? ' · datos de ' + new Date(S.sinSenalDesde).toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit' }) : ''}`; $('hd-st').className = 'st' + (on ? '' : ' off'); $('hd-sub').textContent = S.conductor ? `${S.conductor.nombre}${S.ruta ? ' · ' + S.ruta.codigo + ' · v' + (S.ruta.version || 1) : ''} · ${DB.getMode() === 'supabase' ? 'Supabase' : 'modo local'}` : 'Elige tu usuario'; }
function render() {
  header(); const M = $('main'); const B = $('bottom'); B.classList.add('hidden');
  if (!S.conductor) { M.innerHTML = `<div class="login"><div class="logo">DGP</div><h1 style="text-align:center">¿Quién conduce hoy?</h1><p class="mini" style="text-align:center">Demo: sin contraseña. En producción, SSO de DGP.</p>${S.personas.map(p => `<div class="opt" data-p="${p.id}"><div class="av">${p.nombre.split(' ').map(x => x[0]).join('')}</div><div><b>${esc(p.nombre)}</b><span class="mini">Conductor</span></div></div>`).join('')}</div>`; document.querySelectorAll('[data-p]').forEach(o => o.onclick = async () => { S.conductor = S.personas.find(p => p.id === o.dataset.p); localStorage.setItem('dgp_conductor', JSON.stringify(S.conductor)); await load(); S.screen = S.ruta && S.ruta.estado === 'en_ruta' ? 'ruta' : 'home'; render(); }); return; }
  const RST = { publicada: ['En preparación en bodega', 'p-mut'], en_cargue: ['Cargando en bodega', 'p-info'], liberada: ['Lista para salir', 'p-ok'], en_ruta: ['En ruta', 'p-warn'], cerrada: ['Cerrada', 'p-ok'], conciliada: ['Conciliada', 'p-ok'] };
  const incHtml = (list) => list.length ? list.slice(0, 8).map(i => { const r = S.todas.find(x => x.id === i.ruta_id) || {}; return `<div class="q" style="grid-template-columns:auto 1fr auto"><span class="pill ${i.tipo === 'demora' ? 'p-warn' : (tipoInc(i.tipo) || {}).severidad === 'alta' || i.tipo === 'accidente' ? 'p-crit' : 'p-info'}">${esc(i.tipo === 'demora' ? 'Demora' : (tipoInc(i.tipo) || {}).nombre || i.tipo)}</span><span><b>${r.codigo || ''}</b> · ${esc(i.descripcion || '')}${i.demora_min ? ' · ' + i.demora_min + ' min' : ''}<div class="mini">${new Date(i.created_at).toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit' })}</div></span><span class="pill ${i.estado === 'cerrada' ? 'p-ok' : 'p-mut'}">${i.estado === 'cerrada' ? 'Cerrada' : 'Abierta'}</span></div>`; }).join('') : '<p class="mini">Sin incidencias hoy.</p>';
  if (!S.ruta || S.screen === 'home') {
    const hoy = new Date().toLocaleDateString('es-PA', { weekday: 'long', day: 'numeric', month: 'long' });
    M.innerHTML = `<div class="card"><h1>Hola, ${esc(S.conductor.nombre.split(' ')[0])}</h1><p class="mini" style="margin:0 0 6px">${hoy} · ${S.todas.length} ruta${S.todas.length === 1 ? '' : 's'} asignada${S.todas.length === 1 ? '' : 's'}</p>
      ${S.todas.length ? S.todas.map(r => { const ps = S.paradasTodas.filter(p => p.ruta_id === r.id); const ent = ps.filter(p => p.tipo === 'entrega'); const done = ps.filter(p => !['pendiente', 'en_sitio'].includes(p.estado)).length; const st = RST[r.estado] || [r.estado, 'p-mut']; const activa = ['liberada', 'en_ruta', 'cerrada', 'conciliada'].includes(r.estado); return `<div class="card" style="margin:10px 0 0;padding:12px"><div class="t"><div><b>${r.codigo}</b> · ${esc(r.zona_codigo || '')}<div class="mini">${ent.length} entregas · ${r.cajas || 0} cajas · B/. ${fmt(r.valor)} · salida ${r.hora_salida || '07:00'} · regreso ${r.hora_fin_prevista || '—'}${r.ayudante ? ' · ayudante ' + esc(r.ayudante) : ''}</div></div><span class="pill ${st[1]}">${st[0]}</span></div>${ps.length ? `<div class="prog"><i style="width:${done / ps.length * 100}%"></i></div><div class="mini">${done}/${ps.length} paradas · primera: ${ent[0] && ent[0].cliente_id ? esc(cli(ent[0].cliente_id).nombre) : '—'}</div>` : ''}${activa ? `<button class="big" data-open="${r.id}">${r.estado === 'liberada' ? 'Iniciar ruta' : r.estado === 'en_ruta' ? 'Continuar ruta' : 'Ver resumen'}</button>` : prepHtml(r)}</div>`; }).join('') : `<div class="card" style="margin-top:10px;padding:12px"><b>Sin rutas asignadas hoy</b><p class="mini">Cuando planificación te asigne una ruta aparecerá aquí. ${DB.getMode() === 'local' ? 'Modo local: abre la torre de control en este mismo navegador.' : ''}</p></div>`}
      </div>
      <div class="card"><h2>Mis incidencias</h2>${incHtml(S.incidencias)}</div>
      <button class="big sec" id="b-reload">Actualizar</button>${btnTorre()}<button class="big sec" id="b-logout">${PROD ? 'Cerrar sesión' : 'Cambiar usuario'}</button>`;
    $('b-reload').onclick = async () => { await load(); render(); }; $('b-logout').onclick = () => { if (Auth.activo) { const n = Q.list().length; if (n && !confirm(`Hay ${n} eventos sin sincronizar en este teléfono. Si cierras sesión se enviarán cuando vuelvas a entrar con tu usuario. ¿Cerrar sesión?`)) return; return Auth.logout(); } localStorage.removeItem('dgp_conductor'); S.conductor = null; S.ruta = null; S.screen = 'home'; render(); };
    document.querySelectorAll('[data-area]').forEach(b => b.onclick = () => prepArea(S.todas.find(r => r.id === b.dataset.area)));
    document.querySelectorAll('[data-llamar]').forEach(b => b.onclick = () => prepLlamar(S.todas.find(r => r.id === b.dataset.llamar)));
    document.querySelectorAll('[data-open]').forEach(b => b.onclick = async () => { S.ruta = S.rutas.find(r => r.id === b.dataset.open); S.screen = 'ruta'; await load(); render(); if (S.ruta && S.ruta.estado === 'en_ruta') startPing(); });
    return;
  }
  const r = S.ruta; const ent = S.paradas.filter(s => s.tipo === 'entrega'); const done = S.paradas.filter(s => !['pendiente', 'en_sitio'].includes(s.estado)).length; const cur = curStop();
  if (S.rutas.length > 1) { /* selector */ }
  if (r.estado === 'liberada') {
    M.innerHTML = `<div class="card"><button class="big sec" data-home style="display:inline-flex;width:auto;padding:6px 10px;font-size:12px;margin:0 0 8px">‹ Mi día</button><h1>Inspección previa · ${r.codigo}</h1><div class="kv"><b>Vehículo</b><span>${esc(r.conductor)} · ${S.paradas.length} paradas · ${ent.length} entregas</span><b>Bultos</b><span>${r.cajas} cajas · B/. ${fmt(r.valor)}</span><b>Salida prevista</b><span class="eta">${r.hora_salida || '07:00'}</span></div>
      <label>Odómetro (km)</label><input id="f-odo" type="number" inputmode="numeric" ${PROD ? 'placeholder="Lectura actual" required' : 'value="48212"'}><label>Combustible</label><select id="f-comb"><option>Lleno</option><option selected>3/4</option><option>1/2</option><option>1/4</option></select>
      ${esCamion(r) ? '<label>Pallets cargados</label><input id="f-pal" type="number" inputmode="numeric" placeholder="Ej.: 12">' : ''}
      <label>Lista de verificación</label>${['Luces y direccionales', 'Llantas y presión', 'Frenos', 'Documentos y Panapass', 'Carga asegurada'].map((t, i) => `<div class="q"><span>${t}</span><span></span><input type="checkbox" data-chk checked style="width:22px;height:22px;margin:0"></div>`).join('')}
      <label>Foto del odómetro (opcional)</label>${fotoBotones()}<img class="foto" alt="">
      <button class="big" id="b-salida">Registrar salida de bodega</button></div>${cobrosHtml(r, false)}`; $('b-salida').onclick = salida; document.querySelector('[data-home]').onclick = () => { S.screen = 'home'; render(); }; return;
  }
  if (r.estado === 'cerrada' || r.estado === 'conciliada') { M.innerHTML = `<div class="card"><button class="big sec" data-home style="display:inline-flex;width:auto;padding:6px 10px;font-size:12px;margin:0 0 8px">‹ Mi día</button><h1>Ruta cerrada · ${r.codigo}</h1><div class="kv"><b>Paradas</b><span>${done}/${S.paradas.length}</span><b>Entregas totales</b><span>${ent.filter(s => s.estado === 'atendida').length}</span><b>Parciales</b><span>${ent.filter(s => s.estado === 'parcial').length}</span><b>No entregadas</b><span>${ent.filter(s => s.estado === 'no_entregada').length}</span><b>Km reales</b><span>${r.km_real ?? '—'}</span><b>Incidencias</b><span>${S.incidencias.filter(i => i.ruta_id === r.id).length}</span></div><p class="mini">La torre de control concilia costos, combustible y Panapass.</p><h2 style="margin-top:8px">Incidencias de esta ruta</h2>${incHtml(S.incidencias.filter(i => i.ruta_id === r.id))}</div>${cobrosHtml(r, r.estado === 'cerrada')}`; document.querySelector('[data-home]').onclick = () => { S.screen = 'home'; render(); }; cobrosEventos(); return; }
  // en ruta
  let html = `<div class="card" style="padding:10px 14px"><div class="t"><div><button class="big sec" data-home style="display:inline-flex;width:auto;padding:6px 10px;font-size:12px;margin:0 8px 0 0">‹ Mi día</button><b>${r.codigo}</b> <span class="mini">· ${done}/${S.paradas.length} paradas · regreso ${r.hora_fin_prevista || '—'}</span></div><span class="pill p-info">v${r.version || 1}</span></div><div class="prog"><i style="width:${done / Math.max(S.paradas.length, 1) * 100}%"></i></div></div>`;
  html += cobrosHtml(r, true);
  html += S.paradas.map(s => {
    const c = s.cliente_id ? cli(s.cliente_id) : null; const p = s.pedido_id ? ped(s.pedido_id) : null; const isCur = cur && cur.id === s.id; const isDone = !['pendiente', 'en_sitio'].includes(s.estado);
    const title = s.tipo === 'entrega' ? c.nombre : s.tipo === 'servicio' ? `Servicio · ${c.nombre || 'cliente'}` : s.tipo === 'almuerzo' ? 'Almuerzo del equipo' : s.tipo === 'compra' ? 'Compra en proveedor' : s.tipo;
    let body = `<div class="t"><div><b>${s.secuencia}. ${esc(title)}</b><div class="mini">${s.tipo === 'entrega' ? `${p.numero_factura} · ${p.cajas} bultos · B/. ${fmt(p.valor)}<br>${esc(((p && p.direccion_entrega) || c.direccion || '').slice(0, 70))}${c.ventana_inicio ? `<br>Ventana ${c.ventana_inicio}–${c.ventana_fin}` : ''} · ${esc(c.contacto || '')} ${esc(c.telefono || '')}` : esc(s.notas || '')}</div></div><div style="text-align:right"><div class="eta">${s.eta || '—'}</div><span class="pill ${{ pendiente: 'p-mut', en_sitio: 'p-info', atendida: 'p-ok', parcial: 'p-warn', no_entregada: 'p-crit' }[s.estado] || 'p-mut'}">${(s.tipo === 'servicio' ? { pendiente: 'Pendiente', en_sitio: 'En sitio', atendida: 'Realizado', no_entregada: 'No realizado' } : { pendiente: 'Pendiente', en_sitio: 'En sitio', atendida: 'Atendida', parcial: 'Parcial', no_entregada: 'No entregada' })[s.estado] || s.estado}</span></div></div>`;
    const cobP = s.cliente_id ? cobrosDe(r).filter(c => c.cliente_id === s.cliente_id && c.estado === 'pendiente') : [];
    if (cobP.length && !isDone) body += `<div class="mini" style="margin-top:6px;color:#B45309"><b>💵 Cobrar B/. ${fmt(cobP.reduce((a, c) => a + +c.monto, 0))}</b> · ${cobP.map(c => esc(cbForma(c))).join(' · ')} (ver «Cobros de este viaje»)</div>`;
    if (isCur && s.estado === 'pendiente') body += `<div class="row">${['entrega', 'servicio'].includes(s.tipo) ? `<a class="big sec" href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s7-7 7-12a7 7 0 10-14 0c0 5 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>Navegar</a>` : ''}<button class="big" data-ci="${s.id}">Check-in (GPS)</button></div>`;
    if (isCur && s.estado === 'en_sitio' && s.tipo === 'entrega') {
      const ls = S.lineas.filter(l => l.pedido_id === p.id);
      body += `<div class="mini" style="margin-top:8px">Check-in a ${s.distancia_checkin_m ?? '—'} m · ${new Date(s.checkin_at).toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit' })}</div>
      <label>Recibe (nombre) *</label><input id="f-rec" placeholder="Nombre de quien recibe" autocomplete="off" value="${esc(S.form.rec ?? c.recibe_defecto ?? '')}">
      <label>Firma del receptor</label><canvas class="sig"></canvas>
      <label>Fotos de evidencia (hasta ${(S.reglas.fotos_entrega || {}).maximo || 3})</label>${fotoBotones()}<div class="fotos" id="fotos">${(S.form.fotos || []).map(f => `<img src="${f}" alt="">`).join('')}</div>
      <button class="big" data-ent="total" data-s="${s.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12l5 5L20 7"/></svg>Entrega total</button><div class="row"><button class="big warn" data-modo="p">Parcial</button><button class="big crit" data-modo="n">No entregada</button></div>
      <div id="pan-p" class="panel-ent" hidden><h2 style="margin:10px 0 2px">Entrega parcial</h2><label>Artículos (cajas entregadas / requeridas)</label>${ls.map(l => { const a = S.articulos.find(x => x.sku === l.sku) || {}; return `<div class="q"><span>${esc(a.nombre || l.sku)}<br><span class="mini">${l.sku}</span></span><span class="mini">/ ${l.cantidad_cajas}</span><input type="number" inputmode="numeric" min="0" max="${l.cantidad_cajas}" step="1" data-q="${l.sku}" data-req="${l.cantidad_cajas}" value="${l.cantidad_cajas}"></div>`; }).join('')}
      <label>Causa de la entrega parcial *</label><select id="f-causa-p"><option value="">— Elegir causa —</option>${causasEntregaPara(S.causasEntrega, 'parcial').map(x => `<option value="${esc(x.codigo)}">${esc(x.nombre)}</option>`).join('')}</select><label>Nota</label><input id="f-nota-p" maxlength="200" placeholder="Obligatoria en algunas causas">
      <button class="big warn" data-ent="parcial" data-s="${s.id}">Confirmar entrega parcial</button></div>
      <div id="pan-n" class="panel-ent" hidden><h2 style="margin:10px 0 2px">No entregada</h2><label>Causa de la no entrega *</label><select id="f-causa-n"><option value="">— Elegir causa —</option>${causasEntregaPara(S.causasEntrega, 'no_entrega').map(x => `<option value="${esc(x.codigo)}">${esc(x.nombre)}</option>`).join('')}</select><label>Nota</label><input id="f-nota-n" maxlength="200" placeholder="Obligatoria en algunas causas">
      <button class="big crit" data-ent="no" data-s="${s.id}">Confirmar no entregada</button></div>`;
    }
    if (isCur && s.estado === 'en_sitio' && s.tipo === 'servicio') body += `<div class="mini" style="margin-top:8px">Check-in a ${s.distancia_checkin_m ?? '—'} m · ${s.checkin_at ? new Date(s.checkin_at).toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit' }) : ''}</div>
      <label>Atendió en el cliente (nombre) *</label><input id="f-srec" autocomplete="off" placeholder="Quién recibió el servicio" value="${esc(S.form.srec ?? c.recibe_defecto ?? '')}">
      <label>Firma del cliente</label><canvas class="sig"></canvas>
      <label>Fotos del trabajo (hasta ${(S.reglas.fotos_entrega || {}).maximo || 3})</label>${fotoBotones()}<div class="fotos" id="fotos">${(S.form.fotos || []).map(f => `<img src="${f}" alt="">`).join('')}</div>
      <label>Nota / qué se hizo</label><input id="f-snota" maxlength="250" placeholder="Ej.: se instalaron 2 dispensadores · obligatoria si no se pudo">
      <button class="big" data-srv="ok" data-s="${s.id}">✔ Servicio realizado</button><button class="big crit" data-srv="no" data-s="${s.id}">No se pudo realizar</button>`;
    if (isCur && s.estado === 'en_sitio' && s.tipo !== 'entrega' && s.tipo !== 'servicio') body += `${s.tipo === 'compra' ? `<label>Foto de la factura del proveedor</label>${fotoBotones()}<img class="foto" alt="">` : ''}<button class="big" data-fin="${s.id}">${s.tipo === 'almuerzo' ? 'Terminar almuerzo' : 'Registrar compra'}</button>`;
    if (isDone && s.resultado) body += `<div class="mini" style="margin-top:6px">${esc(s.resultado)}${s.receptor ? ' · recibe ' + esc(s.receptor) : ''}${s.firma ? ' · firma ✔' : ''}${s.foto ? ' · foto ✔' : ''}</div>`;
    return `<div class="card ${isCur ? 'cur' : ''} ${isDone ? 'done' : ''}">${body}</div>`;
  }).join('');
  if (!cur) html += `<div class="card"><h2>Llegada a bodega</h2><label>Odómetro de llegada (km) * <span class="mini">obligatorio para cerrar</span></label><input id="f-odo2" type="number" inputmode="numeric" min="1" step="1" required ${PROD ? `placeholder="${+r.odometro_salida ? 'Salió con ' + (+r.odometro_salida).toLocaleString('es-PA') + ' km' : 'Lectura actual'}"` : `value="${(+r.odometro_salida || 48212) + Math.round((+r.km_plan || 60) * 1.06)}"`}>${esCamion(r) ? `<label>Pallets devueltos (salieron ${r.pallets_salida ?? '—'})</label><input id="f-palr" type="number" inputmode="numeric" value="${r.pallets_salida ?? ''}"><label class="row" style="align-items:center"><input type="checkbox" id="f-palb" checked style="width:22px;height:22px;margin:0"> Pallets en buen estado</label>` : ''}<button class="big" id="b-llegada">Cerrar ruta</button></div>`;
  M.innerHTML = html; initSig(); cobrosEventos(); const bh = document.querySelector('[data-home]'); if (bh) bh.onclick = () => { S.screen = 'home'; render(); };
  document.querySelectorAll('[data-ci]').forEach(b => b.onclick = () => checkin(S.paradas.find(s => s.id === b.dataset.ci)));
  document.querySelectorAll('[data-ent]').forEach(b => b.onclick = () => cerrarParada(S.paradas.find(s => s.id === b.dataset.s), b.dataset.ent));
  document.querySelectorAll('[data-modo]').forEach(b => b.onclick = () => { const m = b.dataset.modo; const pp = $('pan-p'), pn = $('pan-n'); const abrir = m === 'p' ? pp : pn, cerrar = m === 'p' ? pn : pp;
    abrir.hidden = !abrir.hidden; cerrar.hidden = true; document.querySelectorAll('[data-modo]').forEach(x => x.classList.toggle('sel', x.dataset.modo === m && !abrir.hidden)); if (!abrir.hidden) abrir.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  const fr = $('f-rec'); if (fr) fr.oninput = () => { S.form.rec = fr.value; };
  fotoEventos();
  document.querySelectorAll('[data-srv]').forEach(b => b.onclick = () => cerrarServicio(S.paradas.find(s => s.id === b.dataset.s), b.dataset.srv === 'ok'));
  const fsr = $('f-srec'); if (fsr) fsr.oninput = () => { S.form.srec = fsr.value; };
  document.querySelectorAll('[data-fin]').forEach(b => b.onclick = () => terminarParada(S.paradas.find(s => s.id === b.dataset.fin)));
  const bl = $('b-llegada'); if (bl) bl.onclick = llegada;
  B.classList.remove('hidden'); B.innerHTML = `${PROD ? '' : `<button class="big sec" id="b-off">${S.simOffline ? 'Recuperar señal' : 'Simular sin señal'}</button>`}<button class="big warn" id="b-dem">Demora</button><button class="big info" id="b-comb">Combustible</button><button class="big crit" id="b-inc">Incidente</button>`;
  if ($('b-off')) $('b-off').onclick = () => { S.simOffline = !S.simOffline; toast(S.simOffline ? 'Sin señal: los eventos se guardan en el teléfono' : 'Señal recuperada: sincronizando…'); render(); if (!S.simOffline) Q.flush(); };
  $('b-dem').onclick = demora; $('b-comb').onclick = combustible; $('b-inc').onclick = incidente;
}
// DATA-001: todas las acciones del conductor se detienen ante un rechazo de la base y vuelven al estado real del servidor
for (const n of ['prepArea', 'prepLlamar', 'salida', 'checkin', 'cerrarParada', 'terminarParada', 'demora', 'incidente', 'combustible', 'llegada', 'cobroGuardar', 'incidenteGuardar', 'cerrarServicio']) window[n] = conRechazo(window[n]);
// Usuarios con acceso a la torre (admin, planificación, bodega…) pueden volver a ella sin cerrar sesión (la sesión es compartida).
const verTorre = () => !!(Auth.activo && Auth.perfil && (Auth.perfil.permisos || []).some(x => x.startsWith('ver.')));
const btnTorre = () => verTorre() ? `<a class="big info" href="index.html">‹ Volver a la Torre de Control</a>` : '';
// -------- inicio --------
(async function () {
  try { await Auth.init({ requiere: 'app.conductor', offline: true, textoSinAcceso: 'Esta aplicación es para conductores. Usa la Torre de Control desde el computador.' }); } catch (e) { return; }
  try { await DB.init({ offline: true }); } catch (e) { $('main').innerHTML = `<div class="card"><h2>Sin conexión con la base</h2><p class="mini">${esc(e.message || e)}</p><button class="big" onclick="location.reload()">Reintentar</button></div>`; return; }
  if (Auth.activo) {
    if (!Auth.perfil.persona_id) { $('main').innerHTML = `<div class="card"><h2>Usuario sin conductor vinculado</h2><p class="mini">Tu usuario (${esc(Auth.perfil.email)}) no está vinculado a una persona del maestro. Pide a Administración que lo vincule en Usuarios y permisos.</p>${btnTorre()}<button class="big sec" id="b-out">Cerrar sesión</button></div>`; $('b-out').onclick = () => Auth.logout(); return; }
    S.conductor = { id: Auth.perfil.persona_id, nombre: Auth.perfil.persona_nombre }; S.personas = [S.conductor];
  } else {
    S.personas = (await DB.all('personas', { rol: 'conductor' })).filter(p => p.activo !== false);
    try { S.conductor = JSON.parse(localStorage.getItem('dgp_conductor') || 'null'); } catch (e) { }
    if (S.conductor && !S.personas.some(p => p.id === S.conductor.id)) S.conductor = S.personas.find(p => p.nombre === S.conductor.nombre) || null;
  }
  if (S.conductor) { try { await load(); } catch (e) { $('main').innerHTML = `<div class="card"><h2>No se pudieron cargar tus rutas</h2><p class="mini">${esc(e.message || e)}</p><button class="big" onclick="location.reload()">Reintentar</button></div>`; return; } } S.screen = S.ruta && S.ruta.estado === 'en_ruta' ? 'ruta' : 'home'; render();
  if (S.ruta && S.ruta.estado === 'en_ruta') startPing();
  window.addEventListener('online', async () => { header(); if (Auth.offline && !(await Auth.revalidar({ requiere: 'app.conductor' }))) return; if (DB.offline && !Auth.offline) { DB.offline = false; await Q.flush(); try { await load(); render(); } catch (e) { } return; } Q.flush(); }); window.addEventListener('offline', header);
  setInterval(async () => { if (!S.conductor || document.hidden || !Q.online()) return;
    if (DB.offline) { if (Auth.offline && !(await Auth.revalidar({ requiere: 'app.conductor' }))) return; if (Auth.offline) return; DB.offline = false; }   // volvió la señal sin evento "online"
    await Q.flush(); if (S.screen === 'home' || !S.ruta || S.ruta.estado === 'liberada') { const sig = JSON.stringify([S.todas.map(r => r.estado), S.incidencias.length]); await load(); if (JSON.stringify([S.todas.map(r => r.estado), S.incidencias.length]) !== sig) render(); } }, 15000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
})();
