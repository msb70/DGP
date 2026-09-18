/* DGP · App del conductor (PWA, offline-first) */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hhmm = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
const tmin = s => { if (!s) return 0; const [a, b] = s.split(':').map(Number); return a * 60 + b; };
const fmt = n => (+n || 0).toLocaleString('es-PA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toast = t => { const e = $('toast'); e.textContent = t; e.classList.add('on'); clearTimeout(e._t); e._t = setTimeout(() => e.classList.remove('on'), 2800); };
let S = { conductor: null, rutas: [], ruta: null, paradas: [], clientes: [], pedidos: [], lineas: [], articulos: [], reglas: {}, bodega: null, simOffline: false, screen: 'home', form: {} };
// -------- cola offline --------
const Q = {
  key: 'dgp_queue', list() { try { return JSON.parse(localStorage.getItem(this.key) || '[]'); } catch (e) { return []; } }, save(l) { localStorage.setItem(this.key, JSON.stringify(l)); },
  online() { return navigator.onLine && !S.simOffline; },
  async run(op) { if (op.fn === 'insert') return DB.insert(op.table, op.rows); if (op.fn === 'update') return DB.update(op.table, op.match, op.patch); },
  async push(op) { if (this.online()) { try { await this.run(op); return true; } catch (e) { console.warn('fallo, a cola', e); } } const l = this.list(); l.push(Object.assign({ ts: new Date().toISOString() }, op)); this.save(l); header(); return false; },
  async flush() { if (!this.online()) return; let l = this.list(); if (!l.length) return; const n = l.length; for (const op of l) { try { if (op.fn === 'insert') op.rows = (Array.isArray(op.rows) ? op.rows : [op.rows]).map(r => Object.assign({}, r, r.offline !== undefined ? { offline: true } : {})); await this.run(op); l = l.slice(1); this.save(l); } catch (e) { console.warn('flush error', e); break; } } if (!this.list().length) { toast(`${n} eventos sincronizados al recuperar señal`); await load(); render(); } header(); }
};
async function evento(tipo, texto, extra = {}, pos) { const p = pos || await geo(true); return Q.push({ fn: 'insert', table: 'eventos', rows: [{ ruta_id: S.ruta.id, parada_id: extra.parada_id || null, tipo, detalle: Object.assign({ texto }, extra.detalle || {}), lat: p ? p.lat : null, lng: p ? p.lng : null, ts_dispositivo: new Date().toISOString(), offline: !Q.online(), actor: S.conductor.nombre, created_at: new Date().toISOString() }] }); }
// -------- GPS --------
function geo(quiet) { return new Promise(res => { if (!navigator.geolocation) return res(simPos()); navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude, real: true }), () => res(simPos()), { timeout: 6000, maximumAge: 15000, enableHighAccuracy: true }); }); }
function simPos() { const s = curStop(); const b = S.bodega || { lat: 8.956, lng: -79.672 }; const base = s ? s : b; return { lat: +base.lat + (Math.random() - .5) * 0.0006, lng: +base.lng + (Math.random() - .5) * 0.0006, real: false }; }
// -------- carga --------
async function load() {
  const [rutas, clientes, articulos, reglas, bod] = await Promise.all([DB.all('rutas', { conductor: S.conductor.nombre }), DB.all('clientes'), DB.all('articulos'), DB.all('reglas'), DB.all('bodegas')]);
  S.rutas = rutas.filter(r => ['liberada', 'en_ruta', 'cerrada'].includes(r.estado)); S.clientes = clientes; S.articulos = articulos; S.bodega = bod[0]; S.reglas = {}; reglas.forEach(r => S.reglas[r.clave] = r.valor);
  if (S.ruta) S.ruta = S.rutas.find(r => r.id === S.ruta.id) || null;
  if (!S.ruta) S.ruta = S.rutas.find(r => r.estado === 'en_ruta') || S.rutas.find(r => r.estado === 'liberada') || S.rutas[0] || null;
  if (S.ruta) { S.paradas = (await DB.all('paradas', { ruta_id: S.ruta.id })).sort((a, b) => a.secuencia - b.secuencia); S.pedidos = await DB.all('pedidos', { ruta_id: S.ruta.id }); S.lineas = S.pedidos.length ? await DB.all('pedido_lineas', { pedido_id: S.pedidos.map(p => p.id) }) : []; }
}
const cli = id => S.clientes.find(c => c.id === id) || {};
const ped = id => S.pedidos.find(p => p.id === id) || {};
const curStop = () => S.paradas.find(s => ['pendiente', 'en_sitio'].includes(s.estado));
// -------- acciones --------
async function salida() {
  const odo = +$('f-odo').value || 0; const comb = $('f-comb').value; const chk = [...document.querySelectorAll('[data-chk]:checked')].length;
  S.ruta.estado = 'en_ruta'; S.ruta.salida_at = new Date().toISOString(); S.ruta.odometro_salida = odo;
  await Q.push({ fn: 'update', table: 'rutas', match: { id: S.ruta.id }, patch: { estado: 'en_ruta', salida_at: S.ruta.salida_at, odometro_salida: odo } });
  await evento('salida', `Salida de bodega · odómetro ${odo.toLocaleString('es-PA')} km · combustible ${comb} · inspección ${chk}/5 OK`, { detalle: { odometro: odo, combustible: comb, checklist: chk } });
  S.screen = 'ruta'; toast('Salida registrada'); render(); startPing();
}
async function checkin(s) {
  const p = await geo(); const c = s.cliente_id ? cli(s.cliente_id) : { lat: s.lat, lng: s.lng }; const dist = Math.round(GEO.metros(p, { lat: +s.lat, lng: +s.lng })); const radio = +(S.reglas.checkin_radio || {}).metros || 150;
  Object.assign(s, { estado: 'en_sitio', checkin_at: new Date().toISOString(), checkin_lat: p.lat, checkin_lng: p.lng, distancia_checkin_m: dist });
  await Q.push({ fn: 'update', table: 'paradas', match: { id: s.id }, patch: { estado: 'en_sitio', checkin_at: s.checkin_at, checkin_lat: p.lat, checkin_lng: p.lng, distancia_checkin_m: dist } });
  await evento('checkin', `Check-in ${s.tipo === 'entrega' ? c.nombre : s.tipo} · a ${dist} m del punto${p.real ? '' : ' (GPS simulado)'}${dist > radio ? ' · FUERA DEL RADIO ' + radio + ' m' : ''}`, { parada_id: s.id, detalle: { distancia_m: dist, gps: p.real ? 'telefono' : 'simulado' } }, p);
  if (dist > radio) { await Q.push({ fn: 'insert', table: 'alertas', rows: [{ tipo: 'checkin', severidad: 'media', titulo: `${S.ruta.codigo}: check-in a ${dist} m de ${c.nombre || s.tipo}`, detalle: `Radio permitido ${radio} m. Verificar ubicación del cliente en CRM.`, entidad: 'parada', destinatario: 'Patricia Vega', created_at: new Date().toISOString() }] }); toast(`Check-in a ${dist} m: fuera del radio permitido`); } else toast(`Check-in OK · ${dist} m`);
  render();
}
async function cerrarParada(s, resultado) {
  const c = cli(s.cliente_id); const p = ped(s.pedido_id); const now = new Date().toISOString();
  const patch = { estado: resultado === 'total' ? 'atendida' : resultado === 'parcial' ? 'parcial' : 'no_entregada', checkout_at: now };
  let texto = '';
  if (resultado !== 'no') { patch.receptor = $('f-rec').value || 'Encargado de recepción'; patch.firma = S.form.firma || null; patch.foto = S.form.foto || null; }
  if (resultado === 'total') { patch.resultado = 'Entrega total'; texto = `Entrega total ${p.numero_factura} · recibe ${patch.receptor} · firma${patch.foto ? ' + foto' : ''}`; }
  if (resultado === 'parcial') { const q = [...document.querySelectorAll('[data-q]')].map(i => ({ sku: i.dataset.q, ent: +i.value, req: +i.dataset.req })); const falt = q.filter(x => x.ent < x.req); const causa = $('f-causa').value; patch.resultado = `Parcial · ${causa} · faltan ${falt.map(x => x.sku + ' ' + (x.req - x.ent)).join(', ')}`; texto = `Entrega PARCIAL ${p.numero_factura} · ${falt.map(x => `${x.sku} ${x.ent}/${x.req}`).join(', ')} · causa: ${causa} · devolución generada · firma + foto`; for (const x of q) { const l = S.lineas.find(l => l.pedido_id === p.id && l.sku === x.sku); if (l) await Q.push({ fn: 'update', table: 'pedido_lineas', match: { id: l.id }, patch: { entregado: x.ent } }); } }
  if (resultado === 'no') { const causa = $('f-causa').value; patch.resultado = `No entregada · ${causa}`; patch.foto = S.form.foto || null; texto = `NO ENTREGADA ${p.numero_factura} · causa: ${causa} · reprogramación solicitada`; }
  Object.assign(s, patch); await Q.push({ fn: 'update', table: 'paradas', match: { id: s.id }, patch });
  await Q.push({ fn: 'update', table: 'pedidos', match: { id: p.id }, patch: { estado: resultado === 'total' ? 'entregado' : resultado === 'parcial' ? 'parcial' : 'no_entregado' } });
  await evento(resultado === 'total' ? 'entrega' : resultado === 'parcial' ? 'entrega_parcial' : 'no_entrega', texto, { parada_id: s.id, detalle: { factura: p.numero_factura, receptor: patch.receptor, evidencia: { firma: !!patch.firma, foto: !!patch.foto } } });
  if (resultado !== 'total') await Q.push({ fn: 'insert', table: 'alertas', rows: [{ tipo: resultado === 'parcial' ? 'parcial' : 'no_entrega', severidad: resultado === 'parcial' ? 'media' : 'alta', titulo: `${S.ruta.codigo} · ${c.nombre}: ${resultado === 'parcial' ? 'entrega parcial' : 'no entregada'}`, detalle: `${p.numero_factura}: ${patch.resultado}. Acción para ${c.ejecutivo}. RF-045.`, entidad: 'parada', destinatario: c.ejecutivo, created_at: now }] });
  S.form = {}; toast(patch.resultado); render();
}
async function terminarParada(s) { const now = new Date().toISOString(); Object.assign(s, { estado: 'atendida', checkout_at: now, resultado: s.tipo === 'almuerzo' ? 'Almuerzo' : 'Compra registrada' }); await Q.push({ fn: 'update', table: 'paradas', match: { id: s.id }, patch: { estado: 'atendida', checkout_at: now, resultado: s.resultado, foto: S.form.foto || null } }); await evento(s.tipo, s.tipo === 'almuerzo' ? 'Fin de almuerzo del equipo' : 'Compra registrada con factura del proveedor (foto) · dispensadores para ruta', { parada_id: s.id }); S.form = {}; render(); }
async function demora() {
  const min = +prompt('Minutos de demora', '45') || 0; if (!min) return; const motivo = prompt('Motivo', 'Tráfico en Corredor Sur') || 'Demora';
  const pend = S.paradas.filter(s => s.estado === 'pendiente'); for (const s of pend) { s.eta = hhmm(tmin(s.eta) + min); await Q.push({ fn: 'update', table: 'paradas', match: { id: s.id }, patch: { eta: s.eta } }); }
  S.ruta.version = (+S.ruta.version || 1) + 1; await Q.push({ fn: 'update', table: 'rutas', match: { id: S.ruta.id }, patch: { version: S.ruta.version, hora_fin_prevista: hhmm(tmin(S.ruta.hora_fin_prevista) + min) } });
  await Q.push({ fn: 'insert', table: 'incidencias', rows: [{ ruta_id: S.ruta.id, parada_id: (curStop() || {}).id || null, tipo: 'demora', descripcion: motivo, demora_min: min, estado: 'notificada', actor: S.conductor.nombre, created_at: new Date().toISOString() }] });
  await evento('demora', `INCIDENTE demora ${min} min (${motivo}) · ETA recalculadas para ${pend.length} paradas · versión ${S.ruta.version}`, { detalle: { minutos: min, motivo, paradas: pend.length } });
  await Q.push({ fn: 'insert', table: 'alertas', rows: [{ tipo: 'demora', severidad: 'media', titulo: `${S.ruta.codigo}: demora de ${min} min reportada por ${S.conductor.nombre}`, detalle: `${motivo}. ETA recalculadas para ${pend.length} paradas · versión ${S.ruta.version} conservada con historial · clientes y ejecutivos notificados. RF-025/062.`, entidad: 'ruta', destinatario: 'Ejecutivos', created_at: new Date().toISOString() }] });
  toast(`Demora registrada · ETA +${min} min`); render();
}
async function incidente() { const tipo = prompt('Tipo: averia / accidente / otro', 'averia'); if (!tipo) return; const d = prompt('Descripción', 'Llanta baja, cambio en sitio') || ''; await Q.push({ fn: 'insert', table: 'incidencias', rows: [{ ruta_id: S.ruta.id, parada_id: (curStop() || {}).id || null, tipo, descripcion: d, estado: 'registrada', actor: S.conductor.nombre, created_at: new Date().toISOString() }] }); await evento('incidente', `INCIDENTE ${tipo}: ${d}`, { detalle: { tipo, descripcion: d } }); await Q.push({ fn: 'insert', table: 'alertas', rows: [{ tipo: 'incidente', severidad: 'alta', titulo: `${S.ruta.codigo}: ${tipo} reportado por ${S.conductor.nombre}`, detalle: d + ' · Mantenimiento notificado. RF-047.', entidad: 'ruta', destinatario: 'Mantenimiento', created_at: new Date().toISOString() }] }); toast('Incidente reportado'); render(); }
async function combustible() { const l = +prompt('Litros', '38') || 0; if (!l) return; const c = +prompt('Costo B/.', (l * 0.98).toFixed(2)) || 0; const odo = +prompt('Odómetro km', String((+S.ruta.odometro_salida || 48212) + 40)) || 0; await Q.push({ fn: 'insert', table: 'abastecimientos', rows: [{ ruta_id: S.ruta.id, vehiculo_id: S.ruta.vehiculo_id, estacion: 'Terpel Costa del Este', litros: l, costo: c, odometro_km: odo, foto: S.form.foto || null, fecha: new Date().toISOString() }] }); await evento('combustible', `Abastecimiento ${l} L · B/. ${fmt(c)} · odómetro ${odo} · foto del recibo`, { detalle: { litros: l, costo: c, odometro: odo } }); toast('Abastecimiento registrado'); render(); }
async function llegada() { const odo = +$('f-odo2').value || 0; const now = new Date().toISOString(); Object.assign(S.ruta, { estado: 'cerrada', llegada_at: now, odometro_llegada: odo, km_real: odo && S.ruta.odometro_salida ? odo - S.ruta.odometro_salida : null }); await Q.push({ fn: 'update', table: 'rutas', match: { id: S.ruta.id }, patch: { estado: 'cerrada', llegada_at: now, odometro_llegada: odo, km_real: S.ruta.km_real } }); await evento('llegada', `Llegada a bodega · odómetro ${odo.toLocaleString('es-PA')} km · ${S.paradas.filter(s => s.estado === 'parcial' || s.estado === 'no_entregada').length} devoluciones entregadas a bodega`, { detalle: { odometro: odo } }); stopPing(); toast('Ruta cerrada'); render(); }
let pingT = null; function startPing() { stopPing(); pingT = setInterval(async () => { if (!S.ruta || S.ruta.estado !== 'en_ruta') return; const p = await geo(true); Q.push({ fn: 'insert', table: 'posiciones', rows: [{ ruta_id: S.ruta.id, lat: p.lat, lng: p.lng, velocidad: p.real ? null : 24, ts: new Date().toISOString() }] }); }, 30000); } function stopPing() { if (pingT) clearInterval(pingT); pingT = null; }
// -------- firma y foto --------
function initSig() { const c = document.querySelector('canvas.sig'); if (!c) return; const ctx = c.getContext('2d'); c.width = c.offsetWidth * 2; c.height = 280; ctx.scale(2, 2); ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#0F172A'; let d = false; const pos = e => { const r = c.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return [t.clientX - r.left, t.clientY - r.top]; };
  const down = e => { d = true; ctx.beginPath(); ctx.moveTo(...pos(e)); e.preventDefault(); }, move = e => { if (!d) return; ctx.lineTo(...pos(e)); ctx.stroke(); S.form.firma = c.toDataURL('image/png'); e.preventDefault(); }, up = () => d = false;
  c.addEventListener('pointerdown', down); c.addEventListener('pointermove', move); window.addEventListener('pointerup', up); }
function foto(input) { const f = input.files[0]; if (!f) return; const img = new Image(); img.onload = () => { const cv = document.createElement('canvas'); const k = Math.min(1, 640 / img.width); cv.width = img.width * k; cv.height = img.height * k; cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height); S.form.foto = cv.toDataURL('image/jpeg', .6); const el = document.querySelector('.foto'); if (el) { el.src = S.form.foto; el.style.display = 'block'; } toast('Foto adjuntada'); }; img.src = URL.createObjectURL(f); }
// -------- render --------
function header() { const q = Q.list().length; const on = Q.online(); $('hd-st').innerHTML = `<i></i>${on ? 'En línea' : 'Sin señal'}${q ? ' · ' + q + ' en cola' : ''}`; $('hd-st').className = 'st' + (on ? '' : ' off'); $('hd-sub').textContent = S.conductor ? `${S.conductor.nombre}${S.ruta ? ' · ' + S.ruta.codigo + ' · v' + (S.ruta.version || 1) : ''} · ${DB.getMode() === 'supabase' ? 'Supabase' : 'modo local'}` : 'Elige tu usuario'; }
function render() {
  header(); const M = $('main'); const B = $('bottom'); B.classList.add('hidden');
  if (!S.conductor) { M.innerHTML = `<div class="login"><div class="logo">DGP</div><h1 style="text-align:center">¿Quién conduce hoy?</h1><p class="mini" style="text-align:center">Demo: sin contraseña. En producción, SSO de DGP.</p>${S.personas.map(p => `<div class="opt" data-p="${p.id}"><div class="av">${p.nombre.split(' ').map(x => x[0]).join('')}</div><div><b>${esc(p.nombre)}</b><span class="mini">Conductor</span></div></div>`).join('')}</div>`; document.querySelectorAll('[data-p]').forEach(o => o.onclick = async () => { S.conductor = S.personas.find(p => p.id === o.dataset.p); localStorage.setItem('dgp_conductor', JSON.stringify(S.conductor)); await load(); render(); }); return; }
  if (!S.ruta) { M.innerHTML = `<div class="card"><h2>Sin rutas liberadas</h2><p class="mini">Cuando la torre de control verifique el cargue y libere tu ruta, aparecerá aquí. ${DB.getMode() === 'local' ? 'Modo local: abre la torre de control en este mismo navegador.' : ''}</p><button class="big sec" id="b-reload">Actualizar</button><button class="big sec" id="b-logout">Cambiar usuario</button></div>`; $('b-reload').onclick = async () => { await load(); render(); }; $('b-logout').onclick = () => { localStorage.removeItem('dgp_conductor'); S.conductor = null; S.ruta = null; render(); }; return; }
  const r = S.ruta; const ent = S.paradas.filter(s => s.tipo === 'entrega'); const done = S.paradas.filter(s => !['pendiente', 'en_sitio'].includes(s.estado)).length; const cur = curStop();
  if (S.rutas.length > 1) { /* selector */ }
  if (r.estado === 'liberada') {
    M.innerHTML = `<div class="card"><h1>Inspección previa · ${r.codigo}</h1><div class="kv"><b>Vehículo</b><span>${esc(r.conductor)} · ${S.paradas.length} paradas · ${ent.length} entregas</span><b>Bultos</b><span>${r.cajas} cajas · B/. ${fmt(r.valor)}</span><b>Salida prevista</b><span class="eta">${r.hora_salida || '07:00'}</span></div>
      <label>Odómetro (km)</label><input id="f-odo" type="number" inputmode="numeric" value="48212"><label>Combustible</label><select id="f-comb"><option>Lleno</option><option selected>3/4</option><option>1/2</option><option>1/4</option></select>
      <label>Lista de verificación</label>${['Luces y direccionales', 'Llantas y presión', 'Frenos', 'Documentos y Panapass', 'Carga asegurada'].map((t, i) => `<div class="q"><span>${t}</span><span></span><input type="checkbox" data-chk checked style="width:22px;height:22px;margin:0"></div>`).join('')}
      <label>Foto del odómetro (opcional)</label><input type="file" accept="image/*" capture="environment" onchange="foto(this)"><img class="foto" alt="">
      <button class="big" id="b-salida">Registrar salida de bodega</button></div>`; $('b-salida').onclick = salida; return;
  }
  if (r.estado === 'cerrada') { M.innerHTML = `<div class="card"><h1>Ruta cerrada · ${r.codigo}</h1><div class="kv"><b>Paradas</b><span>${done}/${S.paradas.length}</span><b>Entregas totales</b><span>${ent.filter(s => s.estado === 'atendida').length}</span><b>Parciales</b><span>${ent.filter(s => s.estado === 'parcial').length}</span><b>No entregadas</b><span>${ent.filter(s => s.estado === 'no_entregada').length}</span><b>Km reales</b><span>${r.km_real ?? '—'}</span></div><p class="mini">La torre de control concilia costos, combustible y Panapass.</p><button class="big sec" id="b-logout">Cambiar usuario</button></div>`; $('b-logout').onclick = () => { localStorage.removeItem('dgp_conductor'); S.conductor = null; S.ruta = null; render(); }; return; }
  // en ruta
  let html = `<div class="card" style="padding:10px 14px"><div class="t"><div><b>${r.codigo}</b> <span class="mini">· ${done}/${S.paradas.length} paradas · regreso ${r.hora_fin_prevista || '—'}</span></div><span class="pill p-info">v${r.version || 1}</span></div><div class="prog"><i style="width:${done / Math.max(S.paradas.length, 1) * 100}%"></i></div></div>`;
  html += S.paradas.map(s => {
    const c = s.cliente_id ? cli(s.cliente_id) : null; const p = s.pedido_id ? ped(s.pedido_id) : null; const isCur = cur && cur.id === s.id; const isDone = !['pendiente', 'en_sitio'].includes(s.estado);
    const title = s.tipo === 'entrega' ? c.nombre : s.tipo === 'almuerzo' ? 'Almuerzo del equipo' : s.tipo === 'compra' ? 'Compra en proveedor' : s.tipo;
    let body = `<div class="t"><div><b>${s.secuencia}. ${esc(title)}</b><div class="mini">${s.tipo === 'entrega' ? `${p.numero_factura} · ${p.cajas} bultos · B/. ${fmt(p.valor)}<br>${esc((c.direccion || '').slice(0, 70))}${c.ventana_inicio ? `<br>Ventana ${c.ventana_inicio}–${c.ventana_fin}` : ''} · ${esc(c.contacto || '')} ${esc(c.telefono || '')}` : esc(s.notas || '')}</div></div><div style="text-align:right"><div class="eta">${s.eta}</div><span class="pill ${{ pendiente: 'p-mut', en_sitio: 'p-info', atendida: 'p-ok', parcial: 'p-warn', no_entregada: 'p-crit' }[s.estado] || 'p-mut'}">${{ pendiente: 'Pendiente', en_sitio: 'En sitio', atendida: 'Atendida', parcial: 'Parcial', no_entregada: 'No entregada' }[s.estado] || s.estado}</span></div></div>`;
    if (isCur && s.estado === 'pendiente') body += `<div class="row">${s.tipo === 'entrega' ? `<a class="big sec" href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s7-7 7-12a7 7 0 10-14 0c0 5 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>Navegar</a>` : ''}<button class="big" data-ci="${s.id}">Check-in (GPS)</button></div>`;
    if (isCur && s.estado === 'en_sitio' && s.tipo === 'entrega') {
      const ls = S.lineas.filter(l => l.pedido_id === p.id);
      body += `<div class="mini" style="margin-top:8px">Check-in a ${s.distancia_checkin_m ?? '—'} m · ${new Date(s.checkin_at).toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit' })}</div>
      <label>Artículos (cajas entregadas / requeridas)</label>${ls.map(l => { const a = S.articulos.find(x => x.sku === l.sku) || {}; return `<div class="q"><span>${esc(a.nombre || l.sku)}<br><span class="mini">${l.sku}</span></span><span class="mini">/ ${l.cantidad_cajas}</span><input type="number" inputmode="numeric" data-q="${l.sku}" data-req="${l.cantidad_cajas}" value="${l.cantidad_cajas}"></div>`; }).join('')}
      <label>Recibe (nombre)</label><input id="f-rec" placeholder="Nombre de quien recibe" value="${esc(c.contacto || '')}">
      <label>Firma del receptor</label><canvas class="sig"></canvas>
      <label>Foto del comprobante / mercancía</label><input type="file" accept="image/*" capture="environment" onchange="foto(this)"><img class="foto" alt="">
      <label>Causa (si parcial o no entregada)</label><select id="f-causa"><option>Espacio insuficiente en bodega del cliente</option><option>Producto dañado</option><option>Cliente rechaza cantidad</option><option>Local cerrado</option><option>Sin persona autorizada</option><option>Fuera de horario</option></select>
      <button class="big" data-ent="total" data-s="${s.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12l5 5L20 7"/></svg>Entrega total</button><div class="row"><button class="big warn" data-ent="parcial" data-s="${s.id}">Parcial</button><button class="big crit" data-ent="no" data-s="${s.id}">No entregada</button></div>`;
    }
    if (isCur && s.estado === 'en_sitio' && s.tipo !== 'entrega') body += `${s.tipo === 'compra' ? `<label>Foto de la factura del proveedor</label><input type="file" accept="image/*" capture="environment" onchange="foto(this)"><img class="foto" alt="">` : ''}<button class="big" data-fin="${s.id}">${s.tipo === 'almuerzo' ? 'Terminar almuerzo' : 'Registrar compra'}</button>`;
    if (isDone && s.resultado) body += `<div class="mini" style="margin-top:6px">${esc(s.resultado)}${s.receptor ? ' · recibe ' + esc(s.receptor) : ''}${s.firma ? ' · firma ✔' : ''}${s.foto ? ' · foto ✔' : ''}</div>`;
    return `<div class="card ${isCur ? 'cur' : ''} ${isDone ? 'done' : ''}">${body}</div>`;
  }).join('');
  if (!cur) html += `<div class="card"><h2>Llegada a bodega</h2><label>Odómetro (km)</label><input id="f-odo2" type="number" inputmode="numeric" value="${(+r.odometro_salida || 48212) + Math.round((+r.km_plan || 60) * 1.06)}"><button class="big" id="b-llegada">Cerrar ruta</button></div>`;
  M.innerHTML = html; initSig();
  document.querySelectorAll('[data-ci]').forEach(b => b.onclick = () => checkin(S.paradas.find(s => s.id === b.dataset.ci)));
  document.querySelectorAll('[data-ent]').forEach(b => b.onclick = () => cerrarParada(S.paradas.find(s => s.id === b.dataset.s), b.dataset.ent));
  document.querySelectorAll('[data-fin]').forEach(b => b.onclick = () => terminarParada(S.paradas.find(s => s.id === b.dataset.fin)));
  const bl = $('b-llegada'); if (bl) bl.onclick = llegada;
  B.classList.remove('hidden'); B.innerHTML = `<button class="big sec" id="b-off">${S.simOffline ? 'Recuperar señal' : 'Simular sin señal'}</button><button class="big warn" id="b-dem">Demora</button><button class="big info" id="b-comb">Combustible</button><button class="big crit" id="b-inc">Incidente</button>`;
  $('b-off').onclick = () => { S.simOffline = !S.simOffline; toast(S.simOffline ? 'Sin señal: los eventos se guardan en el teléfono' : 'Señal recuperada: sincronizando…'); render(); if (!S.simOffline) Q.flush(); };
  $('b-dem').onclick = demora; $('b-comb').onclick = combustible; $('b-inc').onclick = incidente;
}
// -------- inicio --------
(async function () {
  await DB.init(); S.personas = (await DB.all('personas', { rol: 'conductor' })).filter(p => p.activo !== false);
  try { S.conductor = JSON.parse(localStorage.getItem('dgp_conductor') || 'null'); } catch (e) { }
  if (S.conductor && !S.personas.some(p => p.id === S.conductor.id)) S.conductor = S.personas.find(p => p.nombre === S.conductor.nombre) || null;
  if (S.conductor) await load(); render();
  if (S.ruta && S.ruta.estado === 'en_ruta') startPing();
  window.addEventListener('online', () => { header(); Q.flush(); }); window.addEventListener('offline', header);
  setInterval(async () => { if (!S.conductor || document.hidden || !Q.online()) return; const before = S.ruta ? S.ruta.estado : null; await Q.flush(); if (!S.ruta || S.ruta.estado === 'liberada' || !S.ruta) { await load(); if ((S.ruta ? S.ruta.estado : null) !== before) render(); } }, 15000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
})();
