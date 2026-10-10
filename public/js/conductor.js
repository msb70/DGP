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
    const snap = { ts: Date.now(), todas: S.todas, clientes: S.clientes.filter(c => usados.has(c.id)), articulos: S.articulos, reglas: S.reglasRaw || [], bodega: S.bodega, incidencias: S.incidencias, vehiculos: S.vehiculos, personasAll: S.personasAll, paradasTodas: S.paradasTodas, paquetes: S.paquetes, paradas: S.paradas, pedidos: S.pedidos, lineas: S.lineas, ruta: S.ruta && S.ruta.id };
    localStorage.setItem(snapKey(), JSON.stringify(snap));
  } catch (e) { console.warn('No se pudo guardar la copia sin señal', e); }
}
function restaurarSnap() {
  let s = null; try { s = JSON.parse(localStorage.getItem(snapKey()) || 'null'); } catch (e) { }
  if (!s || Date.now() - s.ts > SNAP_MAX_H * 3600e3) return false;
  Object.assign(S, { todas: s.todas, clientes: s.clientes, articulos: s.articulos, bodega: s.bodega, incidencias: s.incidencias, vehiculos: s.vehiculos, personasAll: s.personasAll, paradasTodas: s.paradasTodas, paquetes: s.paquetes, paradas: s.paradas || [], pedidos: s.pedidos || [], lineas: s.lineas || [], sinSenalDesde: s.ts });
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
  if (p.lat == null) toast('Sin GPS: activa la ubicación del teléfono. El check-in queda marcado para revisión.'); const radio = +(S.reglas.checkin_radio || {}).metros || 150;
  const ci = { estado: 'en_sitio', checkin_at: new Date().toISOString(), checkin_lat: p.lat, checkin_lng: p.lng, distancia_checkin_m: p.lat == null ? null : dist };
  await paso({ fn: 'update', table: 'paradas', match: { id: s.id }, patch: ci }); Object.assign(s, ci);
  await evento('checkin', `Check-in ${s.tipo === 'entrega' ? c.nombre : s.tipo} · ${p.lat == null ? 'SIN GPS' : `a ${dist} m del punto`}${p.real || p.lat == null ? '' : ' (GPS simulado)'}${dist > radio ? ' · FUERA DEL RADIO ' + radio + ' m' : ''}`, { parada_id: s.id, detalle: { distancia_m: p.lat == null ? null : dist, gps: p.real ? 'telefono' : p.lat == null ? 'sin_gps' : 'simulado' } }, p);
  if (dist > radio) { await paso({ fn: 'insert', table: 'alertas', rows: [{ tipo: 'checkin', severidad: 'media', titulo: p.lat == null ? `${S.ruta.codigo}: check-in SIN GPS en ${c.nombre || s.tipo}` : `${S.ruta.codigo}: check-in a ${dist} m de ${c.nombre || s.tipo}`, detalle: `Radio permitido ${radio} m. Verificar ubicación del cliente en CRM.`, entidad: 'parada', destinatario: 'Torre de control', created_at: new Date().toISOString() }] }); toast(`Check-in a ${dist} m: fuera del radio permitido`); } else toast(`Check-in OK · ${dist} m`);
  render();
}
async function cerrarParada(s, resultado) {
  const c = cli(s.cliente_id); const p = ped(s.pedido_id); const now = new Date().toISOString();
  const patch = { estado: resultado === 'total' ? 'atendida' : resultado === 'parcial' ? 'parcial' : 'no_entregada', checkout_at: now };
  let texto = ''; const lineas = [];
  const fotos = S.form.fotos || []; if (fotos.length) { patch.fotos = fotos; patch.foto = fotos[0]; }
  if (resultado !== 'no') { patch.receptor = $('f-rec').value || 'Encargado de recepción'; patch.firma = S.form.firma || null; }
  if (resultado === 'total') { patch.resultado = 'Entrega total'; texto = `Entrega total ${p.numero_factura} · recibe ${patch.receptor} · firma${patch.foto ? ' + foto' : ''}`; }
  if (resultado === 'parcial') {
    const q = [...document.querySelectorAll('[data-q]')].map(i => ({ sku: i.dataset.q, txt: i.value.trim(), ent: Number(i.value), req: +i.dataset.req }));
    // DATA-001: cantidades enteras entre 0 y lo requerido; si no, no se envía nada y el formulario queda como está
    const mal = q.filter(x => x.txt === '' || !Number.isInteger(x.ent) || x.ent < 0 || x.ent > x.req);
    if (mal.length) { toast(`Revisa las cantidades de ${mal.map(x => x.sku).join(', ')}: entre 0 y lo requerido`); const el = document.querySelector(`[data-q="${mal[0].sku}"]`); if (el) el.focus(); return; }
    const falt = q.filter(x => x.ent < x.req); if (!falt.length) { toast('Todas las cantidades están completas: registra entrega total'); return; }
    const causa = $('f-causa').value; patch.resultado = `Parcial · ${causa} · faltan ${falt.map(x => x.sku + ' ' + (x.req - x.ent)).join(', ')}`; texto = `Entrega PARCIAL ${p.numero_factura} · ${falt.map(x => `${x.sku} ${x.ent}/${x.req}`).join(', ')} · causa: ${causa} · devolución generada · firma + foto`;
    for (const x of q) { const l = S.lineas.find(l => l.pedido_id === p.id && l.sku === x.sku); if (l) lineas.push({ id: l.id, entregado: x.ent }); }
  }
  if (resultado === 'no') { const causa = $('f-causa').value; patch.resultado = `No entregada · ${causa}`; texto = `NO ENTREGADA ${p.numero_factura} · causa: ${causa} · reprogramación solicitada`; }
  // parada + pedido + líneas en una sola operación atómica; el estado local cambia solo si se guardó o quedó en cola
  await paso({ fn: 'rpc', name: 'registrar_entrega', args: { parada: s.id, resultado, datos: patch, lineas } });
  Object.assign(s, patch); if (p.id) p.estado = resultado === 'total' ? 'entregado' : resultado === 'parcial' ? 'parcial' : 'no_entregado';
  for (const x of lineas) { const l = S.lineas.find(l => l.id === x.id); if (l) l.entregado = x.entregado; }
  await evento(resultado === 'total' ? 'entrega' : resultado === 'parcial' ? 'entrega_parcial' : 'no_entrega', texto, { parada_id: s.id, detalle: { factura: p.numero_factura, receptor: patch.receptor, evidencia: { firma: !!patch.firma, foto: !!patch.foto } } });
  if (resultado !== 'total') await paso({ fn: 'insert', table: 'alertas', rows: [{ tipo: resultado === 'parcial' ? 'parcial' : 'no_entrega', severidad: resultado === 'parcial' ? 'media' : 'alta', titulo: `${S.ruta.codigo} · ${c.nombre}: ${resultado === 'parcial' ? 'entrega parcial' : 'no entregada'}`, detalle: `${p.numero_factura}: ${patch.resultado}. Acción para ${c.ejecutivo}. RF-045.`, entidad: 'parada', destinatario: c.ejecutivo, created_at: now }] });
  S.form = {}; toast(patch.resultado); render();
}
async function terminarParada(s) { const now = new Date().toISOString(); const fin = { estado: 'atendida', checkout_at: now, resultado: s.tipo === 'almuerzo' ? 'Almuerzo' : 'Compra registrada', foto: S.form.foto || null }; await paso({ fn: 'update', table: 'paradas', match: { id: s.id }, patch: fin }); Object.assign(s, fin); await evento(s.tipo, s.tipo === 'almuerzo' ? 'Fin de almuerzo del equipo' : 'Compra registrada con factura del proveedor (foto) · dispensadores para ruta', { parada_id: s.id }); S.form = {}; render(); }
async function demora() {
  const min = +prompt('Minutos de demora', '45') || 0; if (!min) return; const motivo = prompt('Motivo', 'Tráfico en Corredor Sur') || 'Demora';
  const pend = S.paradas.filter(s => s.estado === 'pendiente'); for (const s of pend) { s.eta = hhmm(tmin(s.eta) + min); await paso({ fn: 'update', table: 'paradas', match: { id: s.id }, patch: { eta: s.eta } }); }
  S.ruta.version = (+S.ruta.version || 1) + 1; await paso({ fn: 'update', table: 'rutas', match: { id: S.ruta.id }, patch: { version: S.ruta.version, hora_fin_prevista: hhmm(tmin(S.ruta.hora_fin_prevista) + min) } });
  await paso({ fn: 'insert', table: 'incidencias', rows: [{ ruta_id: S.ruta.id, parada_id: (curStop() || {}).id || null, tipo: 'demora', descripcion: motivo, demora_min: min, estado: 'notificada', actor: S.conductor.nombre, created_at: new Date().toISOString() }] });
  await avisarClientes('demora: nueva hora de llegada (K6)', (s, c, p) => `DGP: su pedido ${p.numero_factura} llegará con retraso por ${motivo.toLowerCase()}. Nueva hora estimada: ${s.eta}. Disculpe la molestia.`, l => `${S.ruta.codigo}: demora de ${min} min (${motivo}). Nuevas ETA: ${l.join('; ')}.`, pend.filter(x => x.tipo === 'entrega'), (s, c, p) => [p.numero_factura || p.numero_so, motivo.toLowerCase(), s.eta]);
  await evento('demora', `INCIDENTE demora ${min} min (${motivo}) · ETA recalculadas para ${pend.length} paradas · versión ${S.ruta.version}`, { detalle: { minutos: min, motivo, paradas: pend.length } });
  await paso({ fn: 'insert', table: 'alertas', rows: [{ tipo: 'demora', severidad: 'media', titulo: `${S.ruta.codigo}: demora de ${min} min reportada por ${S.conductor.nombre}`, detalle: `${motivo}. ETA recalculadas para ${pend.length} paradas · versión ${S.ruta.version} conservada con historial · clientes y ejecutivos notificados. RF-025/062.`, entidad: 'ruta', destinatario: 'Ejecutivos', created_at: new Date().toISOString() }] });
  toast(`Demora registrada · ETA +${min} min`); render();
}
async function incidente() { const tipo = prompt('Tipo: averia / accidente / otro', 'averia'); if (!tipo) return; const d = prompt('Descripción', 'Llanta baja, cambio en sitio') || ''; await paso({ fn: 'insert', table: 'incidencias', rows: [{ ruta_id: S.ruta.id, parada_id: (curStop() || {}).id || null, tipo, descripcion: d, estado: 'registrada', actor: S.conductor.nombre, created_at: new Date().toISOString() }] }); await evento('incidente', `INCIDENTE ${tipo}: ${d}`, { detalle: { tipo, descripcion: d } }); await paso({ fn: 'insert', table: 'alertas', rows: [{ tipo: 'incidente', severidad: 'alta', titulo: `${S.ruta.codigo}: ${tipo} reportado por ${S.conductor.nombre}`, detalle: d + ' · Mantenimiento notificado. RF-047.', entidad: 'ruta', destinatario: 'Mantenimiento', created_at: new Date().toISOString() }] }); toast('Incidente reportado'); render(); }
async function combustible() { const l = +prompt('Litros', '38') || 0; if (!l) return; const c = +prompt('Costo B/.', (l * 0.98).toFixed(2)) || 0; const odo = +prompt('Odómetro km', String((+S.ruta.odometro_salida || 48212) + 40)) || 0; await paso({ fn: 'insert', table: 'abastecimientos', rows: [{ ruta_id: S.ruta.id, vehiculo_id: S.ruta.vehiculo_id, estacion: 'Terpel Costa del Este', litros: l, costo: c, odometro_km: odo, foto: S.form.foto || null, fecha: new Date().toISOString() }] }); await evento('combustible', `Abastecimiento ${l} L · B/. ${fmt(c)} · odómetro ${odo} · foto del recibo`, { detalle: { litros: l, costo: c, odometro: odo } }); toast('Abastecimiento registrado'); render(); }
async function llegada() { if ($('f-palr')) { const pr = $('f-palr').value === '' ? null : +$('f-palr').value; const pb = $('f-palb').checked; S.ruta.pallets_retorno = pr; S.ruta.pallets_buen_estado = pb; await paso({ fn: 'update', table: 'rutas', match: { id: S.ruta.id }, patch: { pallets_retorno: pr, pallets_buen_estado: pb } }); }
  const odo = +$('f-odo2').value || 0; if (PROD && (!odo || odo < (+S.ruta.odometro_salida || 0))) { toast('Revisa la lectura del odómetro de llegada'); $('f-odo2').focus(); return; } const now = new Date().toISOString(); const cierre = { estado: 'cerrada', llegada_at: now, odometro_llegada: odo, km_real: odo && S.ruta.odometro_salida ? odo - S.ruta.odometro_salida : null }; await paso({ fn: 'update', table: 'rutas', match: { id: S.ruta.id }, patch: cierre }); Object.assign(S.ruta, cierre); await evento('llegada', `Llegada a bodega · odómetro ${odo.toLocaleString('es-PA')} km · ${S.paradas.filter(s => s.estado === 'parcial' || s.estado === 'no_entregada').length} devoluciones entregadas a bodega`, { detalle: { odometro: odo } }); stopPing(); toast('Ruta cerrada'); render(); }
let pingT = null; function startPing() { stopPing(); pingT = setInterval(async () => { if (!S.ruta || S.ruta.estado !== 'en_ruta') return; const p = await geo(true); if (p.lat == null) return; Q.push({ fn: 'insert', table: 'posiciones', rows: [{ ruta_id: S.ruta.id, lat: p.lat, lng: p.lng, velocidad: p.real ? null : 24, ts: new Date().toISOString() }] }); }, 30000); } function stopPing() { if (pingT) clearInterval(pingT); pingT = null; }
// -------- firma y foto --------
function initSig() { const c = document.querySelector('canvas.sig'); if (!c) return; const ctx = c.getContext('2d'); c.width = c.offsetWidth * 2; c.height = 280; ctx.scale(2, 2); ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#0F172A'; let d = false; const pos = e => { const r = c.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return [t.clientX - r.left, t.clientY - r.top]; };
  const down = e => { d = true; ctx.beginPath(); ctx.moveTo(...pos(e)); e.preventDefault(); }, move = e => { if (!d) return; ctx.lineTo(...pos(e)); ctx.stroke(); S.form.firma = c.toDataURL('image/png'); e.preventDefault(); }, up = () => d = false;
  c.addEventListener('pointerdown', down); c.addEventListener('pointermove', move); window.addEventListener('pointerup', up); }
function foto(input) { const f = input.files[0]; if (!f) return; const img = new Image(); img.onload = () => { const cv = document.createElement('canvas'); const k = Math.min(1, 640 / img.width); cv.width = img.width * k; cv.height = img.height * k; cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height); S.form.foto = cv.toDataURL('image/jpeg', .6); const el = document.querySelector('.foto'); if (el) { el.src = S.form.foto; el.style.display = 'block'; } const max = (S.reglas.fotos_entrega || {}).maximo || 3; const box = $('fotos'); if (box) { S.form.fotos = (S.form.fotos || []).concat([S.form.foto]).slice(-max); box.innerHTML = S.form.fotos.map(x => `<img src="${x}" alt="">`).join(''); } input.value = ''; toast(`Foto adjuntada${box ? ' (' + S.form.fotos.length + '/' + max + ')' : ''}`); }; img.src = URL.createObjectURL(f); }
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
  const incHtml = (list) => list.length ? list.slice(0, 8).map(i => { const r = S.todas.find(x => x.id === i.ruta_id) || {}; return `<div class="q" style="grid-template-columns:auto 1fr auto"><span class="pill ${i.tipo === 'demora' ? 'p-warn' : i.tipo === 'accidente' ? 'p-crit' : 'p-info'}">${esc(i.tipo)}</span><span><b>${r.codigo || ''}</b> · ${esc(i.descripcion || '')}${i.demora_min ? ' · ' + i.demora_min + ' min' : ''}<div class="mini">${new Date(i.created_at).toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit' })}</div></span><span class="pill ${i.estado === 'cerrada' ? 'p-ok' : 'p-mut'}">${i.estado === 'cerrada' ? 'Cerrada' : 'Abierta'}</span></div>`; }).join('') : '<p class="mini">Sin incidencias hoy.</p>';
  if (!S.ruta || S.screen === 'home') {
    const hoy = new Date().toLocaleDateString('es-PA', { weekday: 'long', day: 'numeric', month: 'long' });
    M.innerHTML = `<div class="card"><h1>Hola, ${esc(S.conductor.nombre.split(' ')[0])}</h1><p class="mini" style="margin:0 0 6px">${hoy} · ${S.todas.length} ruta${S.todas.length === 1 ? '' : 's'} asignada${S.todas.length === 1 ? '' : 's'}</p>
      ${S.todas.length ? S.todas.map(r => { const ps = S.paradasTodas.filter(p => p.ruta_id === r.id); const ent = ps.filter(p => p.tipo === 'entrega'); const done = ps.filter(p => !['pendiente', 'en_sitio'].includes(p.estado)).length; const st = RST[r.estado] || [r.estado, 'p-mut']; const activa = ['liberada', 'en_ruta', 'cerrada', 'conciliada'].includes(r.estado); return `<div class="card" style="margin:10px 0 0;padding:12px"><div class="t"><div><b>${r.codigo}</b> · ${esc(r.zona_codigo || '')}<div class="mini">${ent.length} entregas · ${r.cajas || 0} cajas · B/. ${fmt(r.valor)} · salida ${r.hora_salida || '07:00'} · regreso ${r.hora_fin_prevista || '—'}${r.ayudante ? ' · ayudante ' + esc(r.ayudante) : ''}</div></div><span class="pill ${st[1]}">${st[0]}</span></div>${ps.length ? `<div class="prog"><i style="width:${done / ps.length * 100}%"></i></div><div class="mini">${done}/${ps.length} paradas · primera: ${ent[0] && ent[0].cliente_id ? esc(cli(ent[0].cliente_id).nombre) : '—'}</div>` : ''}${activa ? `<button class="big" data-open="${r.id}">${r.estado === 'liberada' ? 'Iniciar ruta' : r.estado === 'en_ruta' ? 'Continuar ruta' : 'Ver resumen'}</button>` : prepHtml(r)}</div>`; }).join('') : `<div class="card" style="margin-top:10px;padding:12px"><b>Sin rutas asignadas hoy</b><p class="mini">Cuando planificación te asigne una ruta aparecerá aquí. ${DB.getMode() === 'local' ? 'Modo local: abre la torre de control en este mismo navegador.' : ''}</p></div>`}
      </div>
      <div class="card"><h2>Mis incidencias</h2>${incHtml(S.incidencias)}</div>
      <button class="big sec" id="b-reload">Actualizar</button><button class="big sec" id="b-logout">${PROD ? 'Cerrar sesión' : 'Cambiar usuario'}</button>`;
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
      <label>Foto del odómetro (opcional)</label><input type="file" accept="image/*" capture="environment" onchange="foto(this)"><img class="foto" alt="">
      <button class="big" id="b-salida">Registrar salida de bodega</button></div>`; $('b-salida').onclick = salida; document.querySelector('[data-home]').onclick = () => { S.screen = 'home'; render(); }; return;
  }
  if (r.estado === 'cerrada' || r.estado === 'conciliada') { M.innerHTML = `<div class="card"><button class="big sec" data-home style="display:inline-flex;width:auto;padding:6px 10px;font-size:12px;margin:0 0 8px">‹ Mi día</button><h1>Ruta cerrada · ${r.codigo}</h1><div class="kv"><b>Paradas</b><span>${done}/${S.paradas.length}</span><b>Entregas totales</b><span>${ent.filter(s => s.estado === 'atendida').length}</span><b>Parciales</b><span>${ent.filter(s => s.estado === 'parcial').length}</span><b>No entregadas</b><span>${ent.filter(s => s.estado === 'no_entregada').length}</span><b>Km reales</b><span>${r.km_real ?? '—'}</span></div><p class="mini">La torre de control concilia costos, combustible y Panapass.</p><h2 style="margin-top:8px">Incidencias de esta ruta</h2>${incHtml(S.incidencias.filter(i => i.ruta_id === r.id))}</div>`; document.querySelector('[data-home]').onclick = () => { S.screen = 'home'; render(); }; return; }
  // en ruta
  let html = `<div class="card" style="padding:10px 14px"><div class="t"><div><button class="big sec" data-home style="display:inline-flex;width:auto;padding:6px 10px;font-size:12px;margin:0 8px 0 0">‹ Mi día</button><b>${r.codigo}</b> <span class="mini">· ${done}/${S.paradas.length} paradas · regreso ${r.hora_fin_prevista || '—'}</span></div><span class="pill p-info">v${r.version || 1}</span></div><div class="prog"><i style="width:${done / Math.max(S.paradas.length, 1) * 100}%"></i></div></div>`;
  html += S.paradas.map(s => {
    const c = s.cliente_id ? cli(s.cliente_id) : null; const p = s.pedido_id ? ped(s.pedido_id) : null; const isCur = cur && cur.id === s.id; const isDone = !['pendiente', 'en_sitio'].includes(s.estado);
    const title = s.tipo === 'entrega' ? c.nombre : s.tipo === 'almuerzo' ? 'Almuerzo del equipo' : s.tipo === 'compra' ? 'Compra en proveedor' : s.tipo;
    let body = `<div class="t"><div><b>${s.secuencia}. ${esc(title)}</b><div class="mini">${s.tipo === 'entrega' ? `${p.numero_factura} · ${p.cajas} bultos · B/. ${fmt(p.valor)}<br>${esc((c.direccion || '').slice(0, 70))}${c.ventana_inicio ? `<br>Ventana ${c.ventana_inicio}–${c.ventana_fin}` : ''} · ${esc(c.contacto || '')} ${esc(c.telefono || '')}` : esc(s.notas || '')}</div></div><div style="text-align:right"><div class="eta">${s.eta}</div><span class="pill ${{ pendiente: 'p-mut', en_sitio: 'p-info', atendida: 'p-ok', parcial: 'p-warn', no_entregada: 'p-crit' }[s.estado] || 'p-mut'}">${{ pendiente: 'Pendiente', en_sitio: 'En sitio', atendida: 'Atendida', parcial: 'Parcial', no_entregada: 'No entregada' }[s.estado] || s.estado}</span></div></div>`;
    if (isCur && s.estado === 'pendiente') body += `<div class="row">${s.tipo === 'entrega' ? `<a class="big sec" href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s7-7 7-12a7 7 0 10-14 0c0 5 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>Navegar</a>` : ''}<button class="big" data-ci="${s.id}">Check-in (GPS)</button></div>`;
    if (isCur && s.estado === 'en_sitio' && s.tipo === 'entrega') {
      const ls = S.lineas.filter(l => l.pedido_id === p.id);
      body += `<div class="mini" style="margin-top:8px">Check-in a ${s.distancia_checkin_m ?? '—'} m · ${new Date(s.checkin_at).toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit' })}</div>
      <label>Artículos (cajas entregadas / requeridas)</label>${ls.map(l => { const a = S.articulos.find(x => x.sku === l.sku) || {}; return `<div class="q"><span>${esc(a.nombre || l.sku)}<br><span class="mini">${l.sku}</span></span><span class="mini">/ ${l.cantidad_cajas}</span><input type="number" inputmode="numeric" min="0" max="${l.cantidad_cajas}" step="1" data-q="${l.sku}" data-req="${l.cantidad_cajas}" value="${l.cantidad_cajas}"></div>`; }).join('')}
      <label>Recibe (nombre)</label><input id="f-rec" placeholder="Nombre de quien recibe" value="${esc(c.contacto || '')}">
      <label>Firma del receptor</label><canvas class="sig"></canvas>
      <label>Fotos de evidencia (hasta ${(S.reglas.fotos_entrega || {}).maximo || 3})</label><input type="file" accept="image/*" capture="environment" onchange="foto(this)"><div class="fotos" id="fotos">${(S.form.fotos || []).map(f => `<img src="${f}" alt="">`).join('')}</div>
      <label>Causa (si parcial o no entregada)</label><select id="f-causa"><option>Cliente cerrado por horario</option><option>Devolución por mal empacado</option><option>Faltante de mercancía</option><option>Producto dañado</option><option>Cliente rechaza cantidad</option><option>Espacio insuficiente en bodega del cliente</option><option>Sin persona autorizada</option></select>
      <button class="big" data-ent="total" data-s="${s.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12l5 5L20 7"/></svg>Entrega total</button><div class="row"><button class="big warn" data-ent="parcial" data-s="${s.id}">Parcial</button><button class="big crit" data-ent="no" data-s="${s.id}">No entregada</button></div>`;
    }
    if (isCur && s.estado === 'en_sitio' && s.tipo !== 'entrega') body += `${s.tipo === 'compra' ? `<label>Foto de la factura del proveedor</label><input type="file" accept="image/*" capture="environment" onchange="foto(this)"><img class="foto" alt="">` : ''}<button class="big" data-fin="${s.id}">${s.tipo === 'almuerzo' ? 'Terminar almuerzo' : 'Registrar compra'}</button>`;
    if (isDone && s.resultado) body += `<div class="mini" style="margin-top:6px">${esc(s.resultado)}${s.receptor ? ' · recibe ' + esc(s.receptor) : ''}${s.firma ? ' · firma ✔' : ''}${s.foto ? ' · foto ✔' : ''}</div>`;
    return `<div class="card ${isCur ? 'cur' : ''} ${isDone ? 'done' : ''}">${body}</div>`;
  }).join('');
  if (!cur) html += `<div class="card"><h2>Llegada a bodega</h2><label>Odómetro (km)</label><input id="f-odo2" type="number" inputmode="numeric" ${PROD ? `placeholder="Mayor que ${+r.odometro_salida || 0}"` : `value="${(+r.odometro_salida || 48212) + Math.round((+r.km_plan || 60) * 1.06)}"`}>${esCamion(r) ? `<label>Pallets devueltos (salieron ${r.pallets_salida ?? '—'})</label><input id="f-palr" type="number" inputmode="numeric" value="${r.pallets_salida ?? ''}"><label class="row" style="align-items:center"><input type="checkbox" id="f-palb" checked style="width:22px;height:22px;margin:0"> Pallets en buen estado</label>` : ''}<button class="big" id="b-llegada">Cerrar ruta</button></div>`;
  M.innerHTML = html; initSig(); const bh = document.querySelector('[data-home]'); if (bh) bh.onclick = () => { S.screen = 'home'; render(); };
  document.querySelectorAll('[data-ci]').forEach(b => b.onclick = () => checkin(S.paradas.find(s => s.id === b.dataset.ci)));
  document.querySelectorAll('[data-ent]').forEach(b => b.onclick = () => cerrarParada(S.paradas.find(s => s.id === b.dataset.s), b.dataset.ent));
  document.querySelectorAll('[data-fin]').forEach(b => b.onclick = () => terminarParada(S.paradas.find(s => s.id === b.dataset.fin)));
  const bl = $('b-llegada'); if (bl) bl.onclick = llegada;
  B.classList.remove('hidden'); B.innerHTML = `${PROD ? '' : `<button class="big sec" id="b-off">${S.simOffline ? 'Recuperar señal' : 'Simular sin señal'}</button>`}<button class="big warn" id="b-dem">Demora</button><button class="big info" id="b-comb">Combustible</button><button class="big crit" id="b-inc">Incidente</button>`;
  if ($('b-off')) $('b-off').onclick = () => { S.simOffline = !S.simOffline; toast(S.simOffline ? 'Sin señal: los eventos se guardan en el teléfono' : 'Señal recuperada: sincronizando…'); render(); if (!S.simOffline) Q.flush(); };
  $('b-dem').onclick = demora; $('b-comb').onclick = combustible; $('b-inc').onclick = incidente;
}
// DATA-001: todas las acciones del conductor se detienen ante un rechazo de la base y vuelven al estado real del servidor
for (const n of ['prepArea', 'prepLlamar', 'salida', 'checkin', 'cerrarParada', 'terminarParada', 'demora', 'incidente', 'combustible', 'llegada']) window[n] = conRechazo(window[n]);
// -------- inicio --------
(async function () {
  try { await Auth.init({ requiere: 'app.conductor', offline: true, textoSinAcceso: 'Esta aplicación es para conductores. Usa la Torre de Control desde el computador.' }); } catch (e) { return; }
  try { await DB.init({ offline: true }); } catch (e) { $('main').innerHTML = `<div class="card"><h2>Sin conexión con la base</h2><p class="mini">${esc(e.message || e)}</p><button class="big" onclick="location.reload()">Reintentar</button></div>`; return; }
  if (Auth.activo) {
    if (!Auth.perfil.persona_id) { $('main').innerHTML = `<div class="card"><h2>Usuario sin conductor vinculado</h2><p class="mini">Tu usuario (${esc(Auth.perfil.email)}) no está vinculado a una persona del maestro. Pide a Administración que lo vincule en Usuarios y permisos.</p><button class="big sec" id="b-out">Cerrar sesión</button></div>`; $('b-out').onclick = () => Auth.logout(); return; }
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
