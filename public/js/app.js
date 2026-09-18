/* DGP · Torre de Control · lógica de la aplicación */
const $ = id => document.getElementById(id);
const fmt = n => (+n || 0).toLocaleString('es-PA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const f1 = n => (+n || 0).toLocaleString('es-PA', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const hhmm = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
const tmin = s => { if (!s) return null; const [a, b] = s.split(':').map(Number); return a * 60 + b; };
const hoy = () => new Date().toISOString().slice(0, 10);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ACTOR = 'Patricia Vega';
let S = { zonas: [], clientes: [], articulos: [], vehiculos: [], personas: [], reglas: {}, reglasRows: [], pedidos: [], lineas: [], rutas: [], paradas: [], manifiestos: [], mlineas: [], eventos: [], alertas: [], auditoria: [], incidencias: [], costos: [], peajes: [], posiciones: [], bodega: null, pedTab: 'todos', catTab: 'clientes', view: 'torre' };
let map, layers = { rutas: {}, clientes: null, bodega: null, veh: {} }, hidden = new Set();
const IA = { dir: {}, tri: {}, busy: false };
function modal(html) { $('modal-body').innerHTML = html; $('modal').classList.add('on'); $('modal').onclick = e => { if (e.target === $('modal')) $('modal').classList.remove('on'); }; }
function closeModal() { $('modal').classList.remove('on'); }
const R = k => S.reglas[k] || {};
const cli = id => S.clientes.find(c => c.id === id);
const veh = id => S.vehiculos.find(v => v.id === id);
const zona = code => S.zonas.find(z => z.codigo === code) || { nombre: code, color: '#64748B' };
const toast = t => { const e = $('toast'); e.textContent = t; e.classList.add('on'); clearTimeout(e._t); e._t = setTimeout(() => e.classList.remove('on'), 3000); };

// ===================== CARGA =====================
async function loadAll() {
  const [bod, zonas, clientes, articulos, vehiculos, personas, reglas, pedidos, lineas, rutas, paradas, manifiestos, mlineas, eventos, alertas, auditoria, incidencias, costos, peajes, posiciones] = await Promise.all([
    DB.all('bodegas'), DB.all('zonas'), DB.all('clientes', null, 'codigo'), DB.all('articulos', null, 'sku'), DB.all('vehiculos', null, 'placa'), DB.all('personas', null, 'nombre'), DB.all('reglas'),
    DB.all('pedidos', null, 'numero_so'), DB.all('pedido_lineas'), DB.all('rutas', null, 'codigo'), DB.all('paradas', null, 'secuencia'), DB.all('manifiestos'), DB.all('manifiesto_lineas'),
    DB.all('eventos', null, 'created_at'), DB.all('alertas', null, 'created_at'), DB.all('auditoria', null, 'created_at'), DB.all('incidencias'), DB.all('costos_ruta'), DB.all('peajes'), DB.all('posiciones', null, 'ts')]);
  S.bodega = bod[0]; S.zonas = zonas; S.clientes = clientes; S.articulos = articulos; S.vehiculos = vehiculos; S.personas = personas; S.reglasRows = reglas; S.reglas = {}; reglas.forEach(r => S.reglas[r.clave] = r.valor);
  S.pedidos = pedidos; S.lineas = lineas; S.rutas = rutas; S.paradas = paradas; S.manifiestos = manifiestos; S.mlineas = mlineas; S.eventos = eventos.reverse(); S.alertas = alertas.reverse(); S.auditoria = auditoria.reverse(); S.incidencias = incidencias; S.costos = costos; S.peajes = peajes; S.posiciones = posiciones;
}
async function refreshLive() { // sondeo ligero para seguimiento
  const [paradas, rutas, eventos, alertas, posiciones, pedidos, incidencias] = await Promise.all([DB.all('paradas', null, 'secuencia'), DB.all('rutas', null, 'codigo'), DB.all('eventos', null, 'created_at'), DB.all('alertas', null, 'created_at'), DB.all('posiciones', null, 'ts'), DB.all('pedidos', null, 'numero_so'), DB.all('incidencias')]);
  S.paradas = paradas; S.rutas = rutas; S.eventos = eventos.reverse(); S.alertas = alertas.reverse(); S.posiciones = posiciones; S.pedidos = pedidos; S.incidencias = incidencias;
  $('ctx-sync').textContent = 'Actualizado ' + new Date().toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  render();
}

// ===================== VALIDACIÓN =====================
async function validar() {
  const min = +R('monto_minimo').valor || 40; const byCli = {}; const upd = [];
  S.pedidos.filter(p => p.fecha === hoy() || true).forEach(p => { if (['planificado', 'entregado', 'parcial', 'no_entregado'].includes(p.estado) && p.ruta_id) return; p.estado = 'elegible'; p.causa = null; p.grupo = null; (byCli[p.cliente_id] = byCli[p.cliente_id] || []).push(p); });
  const nuevasAlertas = [];
  Object.values(byCli).forEach(ps => {
    const c = cli(ps[0].cliente_id); const tot = ps.reduce((s, p) => s + +p.valor, 0);
    ps.forEach(p => {
      if (c.credito_bloqueado) { p.estado = 'en_excepcion'; p.causa = 'Crédito bloqueado en Zoho Books · liberar con promesa de pago autorizada'; nuevasAlertas.push(['credito', 'alta', `${p.numero_so} · ${c.nombre}`, p.causa, 'Cuentas por cobrar']); }
      else if (c.geo_estado === 'dudosa' || c.lat == null) { p.estado = 'en_excepcion'; p.causa = 'Dirección sin validar en CRM · confirmar coordenadas'; nuevasAlertas.push(['direccion', 'alta', `${p.numero_so} · ${c.nombre}`, p.causa, c.ejecutivo]); }
      else if (+p.valor < min) {
        if (tot >= min && ps.length > 1) { p.grupo = c.codigo; p.causa = `Complementario: ${ps.length} facturas del mismo cliente suman B/. ${fmt(tot)} ≥ ${min}`; }
        else { p.estado = 'en_excepcion'; p.causa = `Monto B/. ${fmt(p.valor)} < mínimo B/. ${min} · notificado ${c.ejecutivo}: agrupar con otro pedido o diferir`; nuevasAlertas.push(['minimo', 'media', `${p.numero_so} · ${c.nombre}`, p.causa, c.ejecutivo]); }
      }
      upd.push({ id: p.id, estado: p.estado, causa: p.causa, grupo: p.grupo, updated_at: new Date().toISOString() });
    });
  });
  await Promise.all(upd.map(u => DB.update('pedidos', { id: u.id }, u)));
  await DB.remove('alertas', { tipo: ['credito', 'direccion', 'minimo'] });
  for (const a of nuevasAlertas) await DB.alerta(a[0], a[1], a[2], a[3], 'pedido', a[4]);
  const ex = S.pedidos.filter(p => p.estado === 'en_excepcion').length;
  await DB.audit('pedidos', 'validacion', `Validación automática: ${S.pedidos.length - ex} elegibles, ${ex} a bandeja de excepciones (mínimo ${min}, crédito, dirección)`, 'motor de reglas', true);
  toast(`${S.pedidos.length - ex} pedidos elegibles · ${ex} excepciones`); await loadAll(); render();
}

// ===================== PLANIFICACIÓN =====================
function capOK(r, v, p) { return { vol: r.volumen_m3 + +p.volumen_m3 <= +v.cap_volumen_m3, peso: r.peso_kg + +p.peso_kg <= +v.cap_peso_kg, cajas: r.cajas + +p.cajas <= +v.cap_cajas, pos: r.posiciones + pos(p) <= +v.cap_posiciones }; }
const pos = p => Math.round(+p.volumen_m3 / 1.1 * 10) / 10;
async function planificar() {
  const capValor = +$('sim-cap').value || +R('cap_valor').valor || 2500;
  const elegibles = S.pedidos.filter(p => ['elegible', 'diferido', 'pendiente_autorizacion'].includes(p.estado));
  if (!elegibles.length) { toast('No hay pedidos elegibles. Valida primero.'); return; }
  $('plan-msg').innerHTML = '<div class="note">Calculando rutas y trazando calles con OSRM…</div>';
  // limpiar propuesta anterior no publicada
  const viejas = S.rutas.filter(r => r.estado === 'simulada');
  for (const r of viejas) { await DB.remove('paradas', { ruta_id: r.id }); await DB.remove('rutas', { id: r.id }); }
  await DB.remove('alertas', { tipo: ['capacidad', 'cap_valor'] });
  const orden = S.zonas.slice().sort((a, b) => a.prioridad - b.prioridad).map(z => z.codigo);
  const asign = {}; // vehículo por zona: mayor capacidad a la zona con más valor
  const valorZona = {}; elegibles.forEach(p => { const z = cli(p.cliente_id).zona_codigo; valorZona[z] = (valorZona[z] || 0) + +p.valor; });
  const zonasPorValor = Object.keys(valorZona).sort((a, b) => valorZona[b] - valorZona[a]);
  const vehs = S.vehiculos.filter(v => v.activo !== false).slice().sort((a, b) => +b.cap_volumen_m3 - +a.cap_volumen_m3);
  zonasPorValor.forEach((z, i) => asign[z] = vehs[i % vehs.length]);
  const nuevas = []; let n = S.rutas.filter(r => r.estado !== 'simulada').length + 1; const pedUpd = [];
  for (const z of orden) {
    const g = elegibles.filter(p => cli(p.cliente_id).zona_codigo === z).sort((a, b) => (cli(a.cliente_id).ventana_inicio ? 0 : 1) - (cli(b.cliente_id).ventana_inicio ? 0 : 1) || a.numero_so.localeCompare(b.numero_so));
    if (!g.length) continue; const v = asign[z];
    const r = { id: DB.uuid(), codigo: `R-${String(n++).padStart(2, '0')}`, fecha: hoy(), vehiculo_id: v.id, conductor: v.conductor, ayudante: v.ayudante, zona_codigo: z, estado: 'simulada', version: 1, valor: 0, peso_kg: 0, volumen_m3: 0, cajas: 0, posiciones: 0, limite: null, hora_salida: R('hora_salida').valor || '07:00' };
    r._ped = []; r._pendAut = null;
    for (const p of g) {
      if (r.limite) { p.estado = 'diferido'; p.causa = `No asignado: ${r.codigo} cerrada por ${r.limite}`; pedUpd.push(p); continue; }
      const ok = capOK(r, v, p); const fis = Object.keys(ok).find(k => !ok[k]);
      if (fis) { const q = { vol: 'volumen', peso: 'peso', cajas: 'cajas', pos: 'posiciones' }[fis]; r.limite = `capacidad física (${q})`; p.estado = 'diferido'; p.causa = `No asignado: ${r.codigo} alcanzó ${q} con B/. ${fmt(r.valor)} cargados (< límite monetario ${capValor})`; pedUpd.push(p);
        await DB.alerta('capacidad', 'media', `${r.codigo} · ${v.placa}: límite físico de ${q} alcanzado`, `Valor cargado B/. ${fmt(r.valor)} < ${capValor}. ${p.numero_so} (${cli(p.cliente_id).nombre}) queda diferido. RF-023.`, 'ruta', ACTOR);
        await DB.audit('rutas', 'regla_capacidad_fisica', `${r.codigo}: ${p.numero_so} no asignado por ${q}`, 'motor de reglas', true, r.id); continue; }
      if (r.valor + +p.valor > capValor) {
        if ((R('cap_valor').al_alcanzar || 'autorizar') === 'autorizar' && !r._pendAut) { r._pendAut = p; p.estado = 'pendiente_autorizacion'; p.causa = `${r.codigo} llegó a B/. ${fmt(r.valor)} (límite ${capValor}) con espacio disponible · requiere autorización`; pedUpd.push(p);
          await DB.alerta('cap_valor', 'media', `${r.codigo} · ${v.placa}: límite monetario B/. ${capValor} alcanzado con espacio físico disponible`, `${p.numero_so} (${cli(p.cliente_id).nombre}, B/. ${fmt(p.valor)}) pendiente de autorización de Gerencia. RF-022.`, 'ruta', 'Gerencia');
          await DB.audit('rutas', 'regla_capacidad_monetaria', `${r.codigo}: ${p.numero_so} requiere autorización (${fmt(r.valor + +p.valor)} > ${capValor})`, 'motor de reglas', true, r.id); }
        else { p.estado = 'diferido'; p.causa = `No asignado: ${r.codigo} alcanzó el límite monetario`; pedUpd.push(p); }
        r.limite = r.limite || 'límite monetario'; continue;
      }
      r._ped.push(p); p.estado = 'planificado'; p.ruta_id = r.id; p.causa = null; pedUpd.push(p);
      r.valor += +p.valor; r.peso_kg += +p.peso_kg; r.volumen_m3 += +p.volumen_m3; r.cajas += +p.cajas; r.posiciones += pos(p);
    }
    nuevas.push(r);
  }
  // secuenciar y trazar
  for (const r of nuevas) { await secuenciar(r); }
  for (const r of nuevas) {
    const paradas = r._stops; const { _ped, _pendAut, _stops, ...row } = r;
    await DB.insert('rutas', [row]); await DB.insert('paradas', paradas.map(s => Object.assign({ ruta_id: r.id }, s)));
  }
  await Promise.all(pedUpd.map(p => DB.update('pedidos', { id: p.id }, { estado: p.estado, causa: p.causa, ruta_id: p.ruta_id || null })));
  await DB.audit('rutas', 'propuesta', `Propuesta generada por el motor: ${nuevas.length} rutas, ${nuevas.reduce((s, r) => s + r._ped.length, 0)} entregas, límite valor ${capValor}`, 'motor de rutas', true);
  $('plan-msg').innerHTML = ''; toast('Propuesta de rutas generada'); await loadAll(); render();
}
async function secuenciar(r) {
  const B = S.bodega; let cur = { lat: +B.lat, lng: +B.lng }, t = tmin(r.hora_salida || '07:00'), rest = r._ped.slice(), stops = [], lunch = false; const vel = +R('velocidad_media_kmh').valor || 24, tol = +R('ventana_tolerancia').minutos || 15, alm = R('almuerzo');
  const pick = () => { rest.sort((a, b) => { const ca = cli(a.cliente_id), cb = cli(b.cliente_id); const wa = ca.ventana_fin ? tmin(ca.ventana_fin) : 9999, wb = cb.ventana_fin ? tmin(cb.ventana_fin) : 9999; if (Math.abs(wa - wb) > 90) return wa - wb; return GEO.km(cur, ca) - GEO.km(cur, cb); }); return rest.shift(); };
  while (rest.length) {
    const p = pick(); const c = cli(p.cliente_id); const d = GEO.kmVia(cur, c); t += d / vel * 60; let espera = 0;
    if (c.ventana_inicio && t < tmin(c.ventana_inicio)) { espera = tmin(c.ventana_inicio) - t; t = tmin(c.ventana_inicio); }
    const fuera = c.ventana_fin && t > tmin(c.ventana_fin) + tol;
    stops.push({ tipo: 'entrega', pedido_id: p.id, cliente_id: c.id, lat: +c.lat, lng: +c.lng, eta: hhmm(t), ventana_inicio: c.ventana_inicio, ventana_fin: c.ventana_fin, duracion_min: c.tiempo_servicio_min || 15, km_tramo: +d.toFixed(2), estado: 'pendiente', notas: (espera > 1 ? `Espera ${Math.round(espera)} min por ventana. ` : '') + (fuera ? 'FUERA DE VENTANA' : '') });
    t += c.tiempo_servicio_min || 15; cur = c;
    if (!lunch && alm && t >= tmin(alm.desde || '12:00')) { stops.push({ tipo: 'almuerzo', lat: +c.lat, lng: +c.lng, eta: hhmm(t), duracion_min: +alm.duracion_min || 45, km_tramo: 0, estado: 'pendiente', notas: 'Almuerzo del equipo' }); t += +alm.duracion_min || 45; lunch = true; }
  }
  if (r.codigo === 'R-01' && stops.length > 3) { const i = 3; const prev = stops[i - 1]; stops.splice(i, 0, { tipo: 'compra', lat: prev.lat + 0.004, lng: prev.lng + 0.004, eta: hhmm(tmin(prev.eta) + (prev.duracion_min || 15) + 8), duracion_min: 20, km_tramo: 2.1, estado: 'pendiente', notas: 'Compra de dispensadores en proveedor (RF-024) · factura del proveedor como evidencia' }); for (let j = i + 1; j < stops.length; j++) stops[j].eta = hhmm(tmin(stops[j].eta) + 28); t += 28; }
  const back = GEO.kmVia(cur, B); t += back / vel * 60;
  let kmt = stops.reduce((s, x) => s + x.km_tramo, 0) + back;
  // OSRM: geometría y tiempos reales por calle
  const pts = [{ lat: +B.lat, lng: +B.lng }, ...stops.map(s => ({ lat: s.lat, lng: s.lng })), { lat: +B.lat, lng: +B.lng }];
  const rt = await GEO.route(pts);
  if (rt) { r.geometria = rt.coords.filter((_, i) => i % 2 === 0); kmt = rt.km; let tt = tmin(r.hora_salida || '07:00'); stops.forEach((s, i) => { tt += rt.legs[i].min * 1.15; if (s.ventana_inicio && tt < tmin(s.ventana_inicio)) tt = tmin(s.ventana_inicio); s.eta = hhmm(tt); s.km_tramo = +rt.legs[i].km.toFixed(2); tt += s.duracion_min; }); t = tt + rt.legs[rt.legs.length - 1].min * 1.15; }
  r._stops = stops.map((s, i) => Object.assign({ secuencia: i + 1 }, s)); r.km_plan = +kmt.toFixed(1); r.hora_fin_prevista = hhmm(t);
}
async function autorizar(pedId) {
  const p = S.pedidos.find(x => x.id === pedId); const r = S.rutas.find(x => x.estado === 'simulada' && x.zona_codigo === cli(p.cliente_id).zona_codigo); if (!r) return;
  const rutaPed = S.pedidos.filter(x => x.ruta_id === r.id); r._ped = rutaPed.concat([p]);
  Object.assign(r, { valor: +r.valor + +p.valor, peso_kg: +r.peso_kg + +p.peso_kg, volumen_m3: +r.volumen_m3 + +p.volumen_m3, cajas: +r.cajas + +p.cajas, posiciones: +r.posiciones + pos(p) });
  await secuenciar(r); await DB.remove('paradas', { ruta_id: r.id }); await DB.insert('paradas', r._stops.map(s => Object.assign({ ruta_id: r.id }, s)));
  const { _ped, _pendAut, _stops, ...row } = r; await DB.update('rutas', { id: r.id }, row);
  await DB.update('pedidos', { id: p.id }, { estado: 'planificado', ruta_id: r.id, causa: 'Autorizado por Gerencia: excede límite monetario con espacio disponible', autorizado_por: 'Roberto Domínguez' });
  await DB.remove('alertas', { tipo: 'cap_valor' });
  await DB.audit('pedidos', 'autorizacion', `${p.numero_so} incluido en ${r.codigo} sobre el límite monetario · motivo: cliente prioritario`, 'Roberto Domínguez (Gerencia)', false, p.id);
  toast('Autorizado y reasignado'); await loadAll(); render();
}
async function diferir(pedId) { const p = S.pedidos.find(x => x.id === pedId); await DB.update('pedidos', { id: p.id }, { estado: 'diferido', causa: 'Diferido a mañana por decisión de Gerencia' }); await DB.remove('alertas', { tipo: 'cap_valor' }); await DB.audit('pedidos', 'diferido', `${p.numero_so} diferido por Gerencia`, 'Roberto Domínguez (Gerencia)', false, p.id); await loadAll(); render(); }
async function aprobar() {
  const sim = S.rutas.filter(r => r.estado === 'simulada'); if (!sim.length) return;
  for (const r of sim) {
    await DB.update('rutas', { id: r.id }, { estado: 'publicada' });
    const ped = S.pedidos.filter(p => p.ruta_id === r.id); const m = {}; ped.forEach(p => S.lineas.filter(l => l.pedido_id === p.id).forEach(l => { m[l.sku] = m[l.sku] || { sku: l.sku, requerido: 0 }; m[l.sku].requerido += +l.cantidad_cajas; }));
    const man = { id: DB.uuid(), ruta_id: r.id, numero: `MF-${r.codigo.slice(2)}-${hoy().replace(/-/g, '').slice(4)}`, estado: 'pendiente', preparador: 'Marta Rojas', cargador: 'Diego Castillo', verificador: ACTOR };
    await DB.insert('manifiestos', [man]);
    await DB.insert('manifiesto_lineas', Object.values(m).map(x => ({ manifiesto_id: man.id, sku: x.sku, ubicacion: (S.articulos.find(a => a.sku === x.sku) || {}).ubicacion, requerido: x.requerido, cargado: 0 })));
  }
  await DB.audit('rutas', 'publicacion', `${sim.length} rutas aprobadas y publicadas · manifiestos generados`, ACTOR, false);
  toast('Rutas publicadas · manifiestos generados'); await loadAll(); render(); nav('manif');
}

// ===================== CARGUE =====================
async function scan(code, rutaId) {
  const r = S.rutas.find(x => x.id === rutaId); const man = S.manifiestos.find(m => m.ruta_id === rutaId); if (!r || !man) return;
  const art = S.articulos.find(a => a.sku === code || a.codigo_barras === code); if (!art) { logScan(false, `Código ${code} no existe en el catálogo`); return; }
  const l = S.mlineas.find(x => x.manifiesto_id === man.id && x.sku === art.sku);
  if (!l) {
    const otra = S.manifiestos.find(m => S.mlineas.some(x => x.manifiesto_id === m.id && x.sku === art.sku && x.cargado < x.requerido)); const otraR = otra ? S.rutas.find(x => x.id === otra.ruta_id) : null;
    logScan(false, `BLOQUEADO · ${art.sku} ${art.nombre} no pertenece a ${r.codigo}${otraR ? ' (es de ' + otraR.codigo + ')' : ''}. Cargue detenido, verificador notificado.`);
    await DB.alerta('cargue', 'alta', `${r.codigo}: artículo de otra ruta escaneado`, `${art.sku} ${otraR ? 'corresponde a ' + otraR.codigo : 'no está en ningún manifiesto'}. RF-035.`, 'manifiesto', ACTOR);
    await DB.audit('manifiestos', 'escaneo_bloqueado', `${r.codigo}: ${art.sku} pertenece a ${otraR ? otraR.codigo : 'ninguna ruta'}`, 'Diego Castillo', true, man.id); toast('Escaneo bloqueado: artículo de otra ruta'); return;
  }
  if (l.cargado >= l.requerido) { logScan(false, `ALERTA · ${art.sku} ya completo (${l.requerido}/${l.requerido}). Posible sobrecarga.`); return; }
  l.cargado = l.requerido; await DB.update('manifiesto_lineas', { id: l.id }, { cargado: l.cargado }); logScan(true, `OK · ${art.sku} ${art.nombre} · ${l.requerido} cajas · ${art.ubicacion}`);
  const done = S.mlineas.filter(x => x.manifiesto_id === man.id).every(x => x.cargado >= x.requerido);
  const est = done ? 'verificada' : 'en_cargue'; if (man.estado !== est) { man.estado = est; await DB.update('manifiestos', { id: man.id }, { estado: est, inicio_cargue: man.inicio_cargue || new Date().toISOString(), fin_cargue: done ? new Date().toISOString() : null }); if (r.estado === 'publicada') { r.estado = 'en_cargue'; await DB.update('rutas', { id: r.id }, { estado: 'en_cargue' }); } if (done) await DB.audit('manifiestos', 'verificado', `${r.codigo}: cargue verificado sin diferencias`, ACTOR, false, man.id); }
  renderManif();
}
const scanLog = [];
function logScan(ok, t) { scanLog.unshift({ ok, t, ts: new Date() }); }
async function liberar() {
  const id = $('m-ruta').value; const r = S.rutas.find(x => x.id === id); const man = S.manifiestos.find(m => m.ruta_id === id); if (!r) return;
  if (!man || man.estado !== 'verificada') { toast('La ruta no puede liberarse: cargue sin verificar'); return; }
  await DB.update('rutas', { id: r.id }, { estado: 'liberada' }); await DB.audit('rutas', 'liberada', `${r.codigo} liberada al conductor ${r.conductor} · cronograma enviado al móvil`, ACTOR, false, r.id);
  toast(`${r.codigo} liberada a ${r.conductor}`); await loadAll(); render(); nav('seguimiento');
}

// ===================== COSTOS =====================
async function cerrar() {
  const rutas = S.rutas.filter(r => !['simulada'].includes(r.estado)); if (!rutas.length) { toast('No hay rutas publicadas que conciliar'); return; }
  await DB.remove('alertas', { tipo: ['consumo', 'panapass'] });
  for (const [i, r] of rutas.entries()) {
    const v = veh(r.vehiculo_id); const kmReal = r.odometro_llegada && r.odometro_salida ? r.odometro_llegada - r.odometro_salida : +r.km_plan * [1.06, 1.04, 1.09, 1.05][i % 4];
    const lEsp = kmReal / +v.km_por_litro; const anom = v.placa === 'PA-1187' ? 1.24 : 1 + [0.03, 0, 0.05, 0.02][i % 4]; const lReal = lEsp * anom; const desv = (anom - 1) * 100;
    const paradas = S.paradas.filter(p => p.ruta_id === r.id); const ent = paradas.filter(p => p.tipo === 'entrega').length;
    const pe = [{ punto: 'Corredor Norte · Tinajitas', est: 2.75 }, { punto: 'Corredor Sur · Costa del Este', est: 2.05 }, { punto: 'Puente Centenario', est: 1.60 }].filter((_, k) => (k + i) % 2 === 0 || r.zona_codigo === 'CENTRO').map(p => ({ ruta_id: r.id, punto: p.punto, monto_estimado: p.est, monto_real: p.est, fuente: 'importacion_panapass', fuera_de_ruta: false, conciliado: true }));
    if (r.zona_codigo === 'OESTE') pe.push({ ruta_id: r.id, punto: 'Corredor Norte · Villa Zaita', monto_estimado: 0, monto_real: 2.75, fuente: 'importacion_panapass', fuera_de_ruta: true, conciliado: false });
    await DB.remove('peajes', { ruta_id: r.id }); await DB.insert('peajes', pe);
    const cComb = lReal * 0.98, cPe = pe.reduce((s, p) => s + p.monto_real, 0), cMo = r.ayudante ? 150 : 85, cMa = kmReal * 0.09, tot = cComb + cPe + cMo + cMa;
    const costo = { ruta_id: r.id, km_plan: r.km_plan, km_real: +kmReal.toFixed(1), litros_esperados: +lEsp.toFixed(2), litros_reales: +lReal.toFixed(2), desviacion_pct: +desv.toFixed(1), costo_combustible: +cComb.toFixed(2), costo_peajes: +cPe.toFixed(2), costo_mano_obra: cMo, costo_mantenimiento: +cMa.toFixed(2), costo_total: +tot.toFixed(2), valor_vendido: r.valor, entregas: ent, costo_por_entrega: +(tot / Math.max(ent, 1)).toFixed(2), costo_por_km: +(tot / Math.max(kmReal, 1)).toFixed(3), pct_sobre_venta: +(tot / Math.max(+r.valor, 1) * 100).toFixed(2), calculado_at: new Date().toISOString() };
    await DB.upsert('costos_ruta', [costo], 'ruta_id'); await DB.update('rutas', { id: r.id }, { estado: 'conciliada', km_real: costo.km_real });
    if (desv > (+R('desviacion_consumo').pct || 15)) { await DB.alerta('consumo', 'alta', `${v.placa}: consumo ${f1(desv)} % sobre lo esperado`, `Umbral ${R('desviacion_consumo').pct || 15} %. Orden de mantenimiento correctivo creada. RF-051/056.`, 'vehiculo', 'Mantenimiento'); await DB.audit('vehiculos', 'desviacion_consumo', `${v.placa}: ${f1(desv)} % · mantenimiento programado`, 'motor de reglas', true, v.id); }
    for (const p of pe.filter(x => x.fuera_de_ruta)) await DB.alerta('panapass', 'media', `${r.codigo} · Panapass fuera de ruta`, `${p.punto}: B/. ${fmt(p.monto_real)} sin peaje estimado. Revisar con conductor. RF-054.`, 'ruta', ACTOR);
  }
  await DB.audit('rutas', 'conciliacion', `Conciliación diaria de ${rutas.length} rutas: km, combustible y Panapass · estados de envío escritos en Zoho Inventory (simulado)`, 'motor de reglas', true);
  toast('Rutas conciliadas'); await loadAll(); render();
}


// ===================== IA: NORMALIZACIÓN DE DIRECCIONES =====================
async function iaDirecciones() {
  if (IA.busy) return; const pend = S.clientes.filter(c => c.lat == null || ['pendiente', 'dudosa', 'aproximada'].includes(c.geo_estado));
  if (!pend.length) { toast('Todas las direcciones están validadas'); return; }
  IA.busy = true; S.catTab = 'clientes'; $('cat-tabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.t === 'clientes')); renderCatalogo();
  toast(`IA (${AI.modo()}): analizando ${pend.length} direcciones…`);
  for (const c of pend) {
    try {
      const z = zona(c.zona_codigo); const r = await AI.normalizarDireccion(c, z.nombre);
      const g = await GEO.geocode(r.consulta_geocodificacion || c.nombre); await GEO.sleep(1100);
      const dist = g && c.lat != null ? GEO.km({ lat: +c.lat, lng: +c.lng }, g) : null;
      IA.dir[c.id] = Object.assign({ geo: g, dist, estado: 'propuesta', ts: new Date().toISOString() }, r);
    } catch (e) { IA.dir[c.id] = { error: e.message, estado: 'error' }; }
    renderCatalogo();
  }
  await DB.audit('clientes', 'ia_normalizacion', `IA (${AI.modo()}) propuso normalización para ${pend.length} direcciones · pendiente de aprobación humana`, 'IA · normalización', true);
  IA.busy = false; toast('Propuestas listas: revisa y aprueba'); renderCatalogo();
}
async function iaDirAceptar(id) {
  const c = S.clientes.find(x => x.id === id); const p = IA.dir[id]; if (!c || !p) return;
  const patch = { direccion: p.direccion_normalizada || c.direccion, geo_estado: 'validada', updated_at: new Date().toISOString() };
  if (p.geo) { patch.lat = p.geo.lat; patch.lng = p.geo.lng; }
  await DB.update('clientes', { id }, patch); p.estado = 'aceptada';
  await DB.audit('clientes', 'direccion_validada', `${c.nombre}: dirección normalizada por IA (confianza ${Math.round((p.confianza || 0) * 100)} %) y aprobada · "${patch.direccion}"${p.geo ? ` · coordenada ${p.geo.lat.toFixed(5)},${p.geo.lng.toFixed(5)}` : ''}`, ACTOR, false, id);
  toast('Dirección validada'); await loadAll(); render();
}
async function iaDirRechazar(id) { const c = S.clientes.find(x => x.id === id); IA.dir[id].estado = 'rechazada'; await DB.audit('clientes', 'ia_rechazada', `${c.nombre}: propuesta de dirección de la IA rechazada por ${ACTOR}`, ACTOR, false, id); renderCatalogo(); }
function renderIaDir() {
  const ids = Object.keys(IA.dir); const el = $('ia-dir-panel'); if (!ids.length || S.catTab !== 'clientes') { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="card flat" style="border-color:#BFDBFE;background:#F8FAFF"><div class="hd"><div><h3>Propuestas de la IA · ${ids.filter(i => IA.dir[i].estado === 'propuesta').length} pendientes de aprobar</h3><div class="mini">Modo ${AI.modo()} · la IA propone la dirección estructurada y una coordenada verificada en OpenStreetMap; tú apruebas o rechazas. Todo queda en auditoría.</div></div><button class="btn sec xs" id="b-ia-dir-clear">Limpiar</button></div>
  <div class="tw"><table><thead><tr><th>Cliente</th><th>Dirección en CRM</th><th>Propuesta normalizada</th><th>Coordenada</th><th class="num">Confianza</th><th>Notas</th><th></th></tr></thead><tbody>${ids.map(id => { const c = S.clientes.find(x => x.id === id) || {}; const p = IA.dir[id]; if (p.estado === 'error') return `<tr><td>${esc(c.nombre)}</td><td colspan="5" class="note">Error: ${esc(p.error)}</td><td></td></tr>`; const conf = Math.round((p.confianza || 0) * 100); return `<tr><td><b>${esc(c.nombre)}</b><br><span class="badge-geo">${esc(c.geo_estado)}</span></td><td class="mini">${esc(c.direccion || '')}</td><td>${esc(p.direccion_normalizada || '')}<br><span class="mini">${[p.corregimiento, p.distrito, p.provincia].filter(Boolean).map(esc).join(' · ')}${p.referencia ? ' · ref: ' + esc(p.referencia) : ''}</span></td><td class="mini">${p.geo ? `${p.geo.lat.toFixed(5)}, ${p.geo.lng.toFixed(5)}${p.dist != null ? `<br>a ${p.dist < 1 ? Math.round(p.dist * 1000) + ' m' : f1(p.dist) + ' km'} de la actual` : ''}` : '<span class="pill p-warn nodot">sin resultado</span>'}</td><td class="num"><span class="pill ${conf >= 80 ? 'p-ok' : conf >= 60 ? 'p-warn' : 'p-crit'} nodot">${conf} %</span></td><td class="mini">${esc(p.notas || '')}</td><td>${p.estado === 'propuesta' ? `<div class="row" style="gap:4px"><button class="btn xs" data-ia-ok="${id}">Aprobar</button><button class="btn sec xs" data-ia-no="${id}">Rechazar</button></div>` : `<span class="pill ${p.estado === 'aceptada' ? 'p-ok' : 'p-mut'}">${p.estado}</span>`}</td></tr>`; }).join('')}</tbody></table></div></div>`;
  document.querySelectorAll('[data-ia-ok]').forEach(b => b.onclick = () => iaDirAceptar(b.dataset.iaOk)); document.querySelectorAll('[data-ia-no]').forEach(b => b.onclick = () => iaDirRechazar(b.dataset.iaNo));
  const cl = $('b-ia-dir-clear'); if (cl) cl.onclick = () => { Object.keys(IA.dir).forEach(k => delete IA.dir[k]); renderCatalogo(); };
}
// ===================== IA: TRIAGE DE EXCEPCIONES =====================
async function iaTriage(pedId, abrir = true) {
  const p = S.pedidos.find(x => x.id === pedId); const c = cli(p.cliente_id); const otros = S.pedidos.filter(x => x.cliente_id === p.cliente_id && x.id !== p.id);
  if (!IA.tri[pedId]) { toast(`IA (${AI.modo()}): analizando ${p.numero_so}…`); try { IA.tri[pedId] = Object.assign({ ts: new Date().toISOString(), estado: 'propuesta' }, await AI.triage(p, c, S.reglas, otros)); await DB.audit('pedidos', 'ia_triage', `IA (${AI.modo()}) clasificó ${p.numero_so} como ${IA.tri[pedId].categoria} → ${IA.tri[pedId].accion_recomendada} · pendiente de aprobación`, 'IA · triage', true, p.id); } catch (e) { toast('Error de IA: ' + e.message); return; } }
  if (abrir) triageModal(pedId); else render();
}
const ACC = { agrupar: 'Agrupar con otros pedidos del cliente', diferir: 'Diferir a mañana', liberar_credito: 'Solicitar liberación de crédito a CxC', corregir_direccion: 'Corregir dirección en CRM', autorizar: 'Autorizar excepción', cancelar: 'Cancelar pedido' };
function triageModal(pedId) {
  const p = S.pedidos.find(x => x.id === pedId); const c = cli(p.cliente_id); const t = IA.tri[pedId];
  modal(`<div class="hd"><div><h2>Triage de excepción · ${p.numero_so}</h2><div class="mini">${esc(c.nombre)} · B/. ${fmt(p.valor)} · ${esc(p.causa || '')}</div></div><span class="pill ${t.prioridad === 'alta' ? 'p-crit' : t.prioridad === 'media' ? 'p-warn' : 'p-mut'}">Prioridad ${esc(t.prioridad)}</span></div>
  <div class="kv" style="margin-bottom:10px"><b>Categoría</b><span>${esc(t.categoria)}</span><b>Acción recomendada</b><span><b>${esc(ACC[t.accion_recomendada] || t.accion_recomendada)}</b></span><b>Justificación</b><span>${esc(t.justificacion)}</span><b>Si apruebas</b><span class="mini">${esc(t.siguiente_paso_sistema || '')}</span></div>
  <label class="f">Mensaje al ejecutivo (${esc(c.ejecutivo)}) · editable<textarea id="tri-ej" rows="4">${esc(t.mensaje_ejecutivo || '')}</textarea></label>
  <label class="f" style="margin-top:8px">Mensaje al cliente · editable (vacío = no enviar)<textarea id="tri-cl" rows="3">${esc(t.mensaje_cliente || '')}</textarea></label>
  <div class="mini" style="margin-top:6px">Generado por IA en modo <b>${AI.modo()}</b>${t.simulado ? ' (reglas, sin modelo)' : ''} · ${new Date(t.ts).toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit' })}. Nada se envía ni cambia sin tu aprobación.</div>
  <div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn sec" id="tri-cancel">Cerrar</button><button class="btn sec" id="tri-msg">Solo notificar</button><button class="btn" id="tri-ok">Aprobar acción y notificar</button></div>`);
  $('tri-cancel').onclick = closeModal;
  $('tri-msg').onclick = () => triageAplicar(pedId, false); $('tri-ok').onclick = () => triageAplicar(pedId, true);
}
async function triageAplicar(pedId, aplicar) {
  const p = S.pedidos.find(x => x.id === pedId); const c = cli(p.cliente_id); const t = IA.tri[pedId]; const mej = $('tri-ej').value.trim(), mcl = $('tri-cl').value.trim();
  if (mej) await DB.alerta('triage', t.prioridad === 'alta' ? 'alta' : 'media', `WhatsApp a ${c.ejecutivo} · ${p.numero_so}`, mej, 'pedido', c.ejecutivo);
  if (mcl) await DB.alerta('triage_cliente', 'baja', `WhatsApp a cliente ${c.nombre} · ${p.numero_factura}`, mcl, 'pedido', c.nombre);
  let accion = 'notificado';
  if (aplicar) {
    const a = t.accion_recomendada;
    if (a === 'diferir') { await DB.update('pedidos', { id: p.id }, { estado: 'diferido', causa: `Diferido (triage IA aprobado): ${t.justificacion}` }); accion = 'diferido'; }
    else if (a === 'agrupar') { const g = S.pedidos.filter(x => x.cliente_id === p.cliente_id); for (const x of g) await DB.update('pedidos', { id: x.id }, { estado: 'elegible', grupo: c.codigo, causa: `Complementario (triage IA aprobado): ${g.length} facturas del cliente agrupadas` }); accion = 'agrupado'; }
    else if (a === 'liberar_credito') { await DB.alerta('credito', 'alta', `Solicitud de liberación de crédito · ${c.nombre}`, `${p.numero_so} B/. ${fmt(p.valor)}. ${t.justificacion}`, 'pedido', 'Cuentas por cobrar'); await DB.update('pedidos', { id: p.id }, { causa: `Crédito bloqueado · liberación solicitada a CxC (triage IA aprobado)` }); accion = 'solicitud a CxC'; }
    else if (a === 'corregir_direccion') { await DB.update('pedidos', { id: p.id }, { causa: `Dirección sin validar · ejecutivo notificado (triage IA aprobado)` }); accion = 'corrección de dirección solicitada'; }
    else if (a === 'autorizar') { await DB.update('pedidos', { id: p.id }, { estado: 'elegible', causa: `Autorizado (triage IA aprobado por ${ACTOR})` }); accion = 'autorizado'; }
    else if (a === 'cancelar') { await DB.update('pedidos', { id: p.id }, { estado: 'cancelado', causa: `Cancelado (triage IA aprobado)` }); accion = 'cancelado'; }
  }
  t.estado = aplicar ? 'aplicada' : 'notificada';
  await DB.audit('pedidos', 'triage_aprobado', `${p.numero_so}: ${aplicar ? 'acción "' + (ACC[t.accion_recomendada] || t.accion_recomendada) + '" aplicada' : 'solo notificación'} · propuesto por IA (${AI.modo()}), aprobado por ${ACTOR}${mej ? ' · mensaje a ' + c.ejecutivo : ''}${mcl ? ' · mensaje al cliente' : ''}`, ACTOR, false, p.id);
  closeModal(); toast(`Triage aprobado: ${accion}`); await loadAll(); render();
}
async function iaTriageTodas() { const ex = S.pedidos.filter(p => p.estado === 'en_excepcion' && !IA.tri[p.id]); if (!ex.length) { toast(S.pedidos.some(p => p.estado === 'en_excepcion') ? 'Todas las excepciones ya tienen triage' : 'No hay excepciones. Valida los pedidos primero.'); return; } S.pedTab = 'en_excepcion'; $('ped-tabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.t === 'en_excepcion')); for (const p of ex) await iaTriage(p.id, false); toast(`${ex.length} excepciones clasificadas · revisa y aprueba`); render(); }

// ===================== RENDER =====================
function nav(v) { S.view = v; document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v)); document.querySelectorAll('.view').forEach(s => s.classList.toggle('on', s.id === 'v-' + v));
  $('vtitle').textContent = { torre: 'Torre de control diaria', pedidos: 'Pedidos y elegibilidad', plan: 'Planificación y optimización', manif: 'Manifiesto maestro y cargue', seguimiento: 'Seguimiento en vivo', costos: 'Costos, combustible y flota', reglas: 'Reglas de negocio y auditoría', catalogo: 'Catálogo de datos maestros', config: 'Conexión y app móvil' }[v]; window.scrollTo({ top: 0 }); if (v === 'torre' && map) setTimeout(() => map.invalidateSize(), 50); }
const EST = { pendiente_validar: ['Pendiente de validar', 'p-mut'], elegible: ['Elegible', 'p-ok'], en_excepcion: ['En excepción', 'p-crit'], planificado: ['Planificado', 'p-info'], diferido: ['Diferido', 'p-warn'], pendiente_autorizacion: ['Pend. autorización', 'p-warn'], entregado: ['Entregado', 'p-ok'], parcial: ['Parcial', 'p-warn'], no_entregado: ['No entregado', 'p-crit'], cancelado: ['Cancelado', 'p-mut'] };
const pill = e => { const x = EST[e] || [e, 'p-mut']; return `<span class="pill ${x[1]}">${x[0]}</span>`; };
const rpill = e => { const m = { simulada: ['Simulada', 'p-mut'], publicada: ['Publicada', 'p-info'], en_cargue: ['En cargue', 'p-info'], liberada: ['Liberada', 'p-vio'], en_ruta: ['En ruta', 'p-warn'], cerrada: ['Cerrada', 'p-ok'], conciliada: ['Conciliada', 'p-ok'] }[e] || [e, 'p-mut']; return `<span class="pill ${m[1]}">${m[0]}</span>`; };
const spill = t => ({ entrega: '<span class="pill p-info">Entrega</span>', almuerzo: '<span class="pill p-mut">Almuerzo</span>', compra: '<span class="pill p-warn">Compra</span>', recogida: '<span class="pill p-vio">Recogida</span>' }[t] || t);
const stpill = e => { const m = { pendiente: ['Pendiente', 'p-mut'], en_sitio: ['En sitio', 'p-info'], atendida: ['Atendida', 'p-ok'], parcial: ['Parcial', 'p-warn'], no_entregada: ['No entregada', 'p-crit'], reprogramada: ['Reprogramada', 'p-warn'] }; const x = m[e] || [e, 'p-mut']; return `<span class="pill ${x[1]}">${x[0]}</span>`; };
function etapa() { const P = S.pedidos; if (S.rutas.some(r => r.estado === 'conciliada')) return 6; if (S.rutas.some(r => ['liberada', 'en_ruta', 'cerrada'].includes(r.estado))) return 5; if (S.rutas.some(r => ['publicada', 'en_cargue'].includes(r.estado))) return 4; if (S.rutas.length) return 3; if (P.some(p => p.estado !== 'pendiente_validar')) return 2; return 1; }
function render() {
  const P = S.pedidos, ex = P.filter(p => p.estado === 'en_excepcion'), el = P.filter(p => ['elegible', 'planificado'].includes(p.estado));
  $('n-exc').textContent = ex.length; $('n-exc').className = 'n' + (ex.length ? ' hot' : '');
  const et = etapa(); $('stage').innerHTML = ['Importados', 'Validados', 'Propuesta', 'Publicadas', 'En ejecución', 'Conciliado'].map((s, i) => `<span class="${i + 1 < et ? 'done' : i + 1 === et ? 'cur' : ''}">${s}</span>`).join('');
  const fecha = new Date().toLocaleDateString('es-PA', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' }); $('ctx-fecha').textContent = fecha; $('foot-fecha').textContent = fecha;
  // KPIs torre
  const enRuta = S.rutas.filter(r => ['liberada', 'en_ruta'].includes(r.estado)).length, ent = S.paradas.filter(p => p.tipo === 'entrega'), atend = ent.filter(p => ['atendida', 'parcial', 'no_entregada'].includes(p.estado)).length;
  const ico = { box: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/></svg>', ok: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12l5 5L20 7"/></svg>', warn: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4m0 4h.01M10.3 3.9L2.5 17.5A2 2 0 004.2 21h15.6a2 2 0 001.7-3.5L13.7 3.9a2 2 0 00-3.4 0z"/></svg>', truck: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="6" width="14" height="10" rx="2"/><path d="M15 9h4l3 3v4h-7z"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></svg>' };
  $('kpis').innerHTML = [['Pedidos del día', P.length, `B/. ${fmt(P.reduce((s, p) => s + +p.valor, 0))} · ${new Set(P.map(p => p.cliente_id)).size} clientes`, ico.box, ''], ['Elegibles / planificados', el.length, `${P.filter(p => p.estado === 'planificado').length} asignados a ruta`, ico.ok, ''], ['En excepción', ex.length, ex.length ? 'Requieren acción de ejecutivo o CxC' : 'Sin excepciones', ico.warn, ex.length ? 'crit' : ''], ['Rutas', S.rutas.length, S.rutas.length ? `${enRuta} en ejecución · ${atend}/${ent.length} entregas atendidas · ${f1(S.rutas.reduce((s, r) => s + (+r.km_plan || 0), 0))} km` : 'Sin planificar', ico.truck, 'info']].map(k => `<div class="card tile ${k[4]}"><div class="ico">${k[3]}</div><div class="l">${k[0]}</div><div class="v">${k[1]}</div><div class="s">${k[2]}</div></div>`).join('');
  $('tb-rutas').innerHTML = S.rutas.length ? S.rutas.map(r => { const v = veh(r.vehiculo_id) || {}; const ps = S.paradas.filter(p => p.ruta_id === r.id && p.tipo === 'entrega'); return `<tr><td class="code"><b style="color:${v.color}">${r.codigo}</b><br><span class="mini">${zona(r.zona_codigo).nombre}</span></td><td>${v.placa} <span class="mini">${v.nombre}</span><br><span class="mini">${r.conductor}${r.ayudante ? ' + ' + r.ayudante : ''}</span></td><td>${rpill(r.estado)}${r.version > 1 ? ` <span class="pill p-info nodot">v${r.version}</span>` : ''}</td><td class="num">${ps.filter(p => ['atendida', 'parcial', 'no_entregada'].includes(p.estado)).length}/${ps.length}</td><td class="num">${fmt(r.valor)}</td><td class="num">${f1(r.km_plan)}</td><td class="num">${r.hora_fin_prevista || '—'}</td></tr>`; }).join('') : `<tr><td colspan="7" class="note">Valida los pedidos y genera la propuesta en Planificación.</td></tr>`;
  $('rutas-note').textContent = S.rutas.length ? `${S.rutas.length} rutas · ${ent.length} entregas` : 'Sin rutas generadas todavía';
  const al = S.alertas.filter(a => !a.cerrada); $('alertas').innerHTML = al.length ? al.slice(0, 10).map(a => `<div class="alert ${a.severidad === 'alta' ? 'crit' : a.severidad === 'media' ? 'warn' : 'info'}"><span class="dot"></span><div><b>${esc(a.titulo)}</b><small>${esc(a.detalle)}${a.destinatario ? ' · → ' + esc(a.destinatario) : ''}</small></div></div>`).join('') : `<div class="empty">Sin alertas. Al validar pedidos aparecerán aquí las excepciones con causa y responsable.</div>`;
  $('al-note').textContent = al.length ? `${al.length} activas · escalamiento a las ${R('escalamiento_excepcion').horas || 2} h` : '';
  drawMap();
  // pedidos
  $('ped-kpis').innerHTML = [['Importados', P.length, 'Zoho Inventory · Books'], ['Elegibles', el.length, 'listos para planificar'], ['Complementarios agrupados', P.filter(p => p.grupo).length, 'facturas < mínimo sumadas por cliente'], ['Excepciones', ex.length, 'con causa y responsable']].map(k => `<div class="tile"><div class="l">${k[0]}</div><div class="v">${k[1]}</div><div class="s">${k[2]}</div></div>`).join('');
  let rows = P; if (S.pedTab === 'elegible') rows = P.filter(p => ['elegible', 'planificado', 'pendiente_autorizacion'].includes(p.estado)); if (S.pedTab === 'en_excepcion') rows = ex; if (S.pedTab === 'agrupados') rows = P.filter(p => p.grupo); if (S.pedTab === 'diferido') rows = P.filter(p => p.estado === 'diferido');
  $('tb-ped').innerHTML = rows.map(p => { const c = cli(p.cliente_id) || {}; const z = zona(c.zona_codigo); const r = S.rutas.find(x => x.id === p.ruta_id); return `<tr><td class="code">${p.numero_so}<br><span class="mini">${p.numero_factura}</span></td><td><b>${esc(c.nombre)}</b>${p.grupo ? ' <span class="pill p-info nodot">grupo</span>' : ''}<br><span class="mini">${esc((c.direccion || '').slice(0, 60))}</span></td><td><span class="pill nodot" style="background:${z.color}1f;color:${z.color}">${z.nombre.split(' ·')[0]}</span></td><td>${esc(c.ejecutivo)}</td><td class="code">${c.ventana_inicio ? c.ventana_inicio + '–' + c.ventana_fin : '—'}</td><td class="num">${fmt(p.valor)}</td><td class="num">${f1(p.peso_kg)}</td><td class="num">${(+p.volumen_m3).toFixed(2)}</td><td class="num">${p.cajas}</td><td>${pill(p.estado)}${r ? ` <span class="code">${r.codigo}</span>` : ''}</td><td class="note">${esc(p.causa || '')}${p.estado === 'pendiente_autorizacion' ? ` <div class="row" style="margin-top:4px"><button class="btn xs" data-aut="${p.id}">Autorizar</button><button class="btn sec xs" data-dif="${p.id}">Diferir</button></div>` : ''}${p.estado === 'en_excepcion' ? ` <div class="row" style="margin-top:4px"><button class="btn ${IA.tri[p.id] ? 'info' : 'sec'} xs" data-tri="${p.id}">${IA.tri[p.id] ? (IA.tri[p.id].estado === 'propuesta' ? 'Ver propuesta IA: ' + esc(ACC[IA.tri[p.id].accion_recomendada] || '') : 'Triage ' + IA.tri[p.id].estado) : 'Triage IA'}</button></div>` : ''}</td></tr>`; }).join('') || `<tr><td colspan="11" class="note">Nada en esta vista.</td></tr>`;
  // plan
  if (!$('sim-cap').value) $('sim-cap').value = R('cap_valor').valor || 2500;
  const capValor = +$('sim-cap').value || 2500;
  $('b-aprobar').disabled = !S.rutas.some(r => r.estado === 'simulada');
  $('plan-veh').innerHTML = S.rutas.length ? S.rutas.map(r => { const v = veh(r.vehiculo_id) || {}; const ped = S.pedidos.filter(p => p.ruta_id === r.id); const pend = S.pedidos.find(p => p.estado === 'pendiente_autorizacion' && cli(p.cliente_id).zona_codigo === r.zona_codigo && r.estado === 'simulada');
    const b = (l, x, m, u) => { const pc = Math.min(100, x / m * 100); return `<div><div class="cap"><span>${l}</span><span class="code">${x % 1 ? f1(x) : x} / ${m} ${u}</span></div><div class="bar ${pc >= 100 ? 'c' : pc >= 85 ? 'w' : ''}"><i style="width:${pc}%"></i></div></div>`; };
    return `<div class="card veh" style="--vc:${v.color}"><div class="hd"><div><h3>${r.codigo} · ${zona(r.zona_codigo).nombre}</h3><div class="mini">${v.placa} ${v.nombre} · ${r.conductor}${r.ayudante ? ' + ' + r.ayudante : ''}</div></div><div>${rpill(r.estado)}</div></div>
    <div class="stack" style="gap:7px">${b('Valor B/.', Math.round(r.valor), capValor, '')}${b('Peso', Math.round(r.peso_kg), v.cap_peso_kg, 'kg')}${b('Volumen', +(+r.volumen_m3).toFixed(1), v.cap_volumen_m3, 'm³')}${b('Cajas', r.cajas, v.cap_cajas, '')}${b('Posiciones', +(+r.posiciones).toFixed(1), v.cap_posiciones, '')}</div>
    <div class="row" style="margin-top:12px;justify-content:space-between"><span class="mini">${ped.length} entregas · ${f1(r.km_plan)} km por calle · regreso ${r.hora_fin_prevista || '—'}</span>${r.limite ? `<span class="pill p-warn">Cerrada por ${r.limite}</span>` : '<span class="pill p-ok">Con capacidad</span>'}</div>
    ${pend ? `<div class="alert warn" style="margin-top:10px"><span class="dot"></span><div><b>${pend.numero_so} · ${esc(cli(pend.cliente_id).nombre)} · B/. ${fmt(pend.valor)}</b><small>Excedería el límite monetario con espacio físico disponible. Requiere autorización de Gerencia (trazable).</small><div class="row" style="margin-top:6px"><button class="btn sm" data-aut="${pend.id}">Autorizar y asignar</button><button class="btn sec sm" data-dif="${pend.id}">Diferir a mañana</button></div></div></div>` : ''}</div>`; }).join('') : `<div class="card empty" style="grid-column:1/-1">Primero valida los pedidos; luego genera la propuesta. Prueba a bajar el límite de valor a 1.500 para ver más pedidos pendientes de autorización.</div>`;
  $('plan-detail').innerHTML = S.rutas.length ? S.rutas.map(r => { const v = veh(r.vehiculo_id) || {}; const st = S.paradas.filter(p => p.ruta_id === r.id).sort((a, b) => a.secuencia - b.secuencia); return `<h3 style="margin:12px 0 8px;color:${v.color}">${r.codigo} · ${v.placa} · ${zona(r.zona_codigo).nombre}</h3><div class="tw"><table><thead><tr><th class="num">#</th><th>Parada</th><th>Tipo</th><th>Ventana</th><th class="num">ETA</th><th class="num">Km tramo</th><th class="num">Servicio</th><th>Estado</th></tr></thead><tbody>${st.map(s => { const c = s.cliente_id ? cli(s.cliente_id) : null; const p = s.pedido_id ? S.pedidos.find(x => x.id === s.pedido_id) : null; return `<tr><td class="num">${s.secuencia}</td><td>${c ? `<b>${esc(c.nombre)}</b> <span class="mini">${p ? p.numero_factura : ''}</span>` : esc(s.notas)}</td><td>${spill(s.tipo)}</td><td class="code">${s.ventana_inicio ? s.ventana_inicio + '–' + s.ventana_fin : '—'}</td><td class="num">${s.eta}${(s.notas || '').includes('FUERA') ? ' <span class="pill p-crit nodot">fuera</span>' : (s.notas || '').startsWith('Espera') ? ' <span class="pill p-info nodot">espera</span>' : ''}</td><td class="num">${f1(s.km_tramo)}</td><td class="num">${s.duracion_min}′</td><td>${stpill(s.estado)}</td></tr>`; }).join('')}</tbody></table></div>`; }).join('') : `<div class="empty">Genera la propuesta para ver la secuencia de paradas.</div>`;
  document.querySelectorAll('[data-aut]').forEach(b => b.onclick = () => autorizar(b.dataset.aut)); document.querySelectorAll('[data-tri]').forEach(b => b.onclick = () => iaTriage(b.dataset.tri)); document.querySelectorAll('[data-dif]').forEach(b => b.onclick = () => diferir(b.dataset.dif));
  renderManif(); renderSeguimiento(); renderCostos(); renderReglas(); renderCatalogo(); renderConfig();
}
function renderManif() {
  const pub = S.rutas.filter(r => S.manifiestos.some(m => m.ruta_id === r.id)); const sel = $('m-ruta'); const prev = sel.value; sel.innerHTML = pub.map(r => `<option value="${r.id}">${r.codigo} · ${(veh(r.vehiculo_id) || {}).placa} · ${zona(r.zona_codigo).nombre}</option>`).join('') || '<option value="">Sin rutas publicadas</option>'; if (pub.some(r => r.id === prev)) sel.value = prev;
  const r = pub.find(x => x.id === sel.value);
  if (!r) { $('m-kpis').innerHTML = '<div class="empty" style="grid-column:1/-1">Aprueba y publica las rutas en Planificación para generar los manifiestos.</div>'; $('tb-cons').innerHTML = ''; $('tb-det').innerHTML = ''; $('scan-sel').innerHTML = ''; $('scan-log').innerHTML = ''; $('b-liberar').disabled = true; return; }
  const man = S.manifiestos.find(m => m.ruta_id === r.id); const L = S.mlineas.filter(l => l.manifiesto_id === man.id).sort((a, b) => (a.ubicacion || '').localeCompare(b.ubicacion || '')); const ped = S.pedidos.filter(p => p.ruta_id === r.id);
  $('m-kpis').innerHTML = [['Manifiesto', man.numero, r.codigo], ['Facturas', ped.length, 'sin fusionar'], ['Artículos / cajas', `${L.length} / ${L.reduce((s, l) => s + l.requerido, 0)}`, 'consolidado para picking'], ['Cargado', `${L.filter(l => l.cargado >= l.requerido).length} / ${L.length}`, man.estado]].map(k => `<div class="tile"><div class="l">${k[0]}</div><div class="v" style="font-size:20px">${k[1]}</div><div class="s">${k[2]}</div></div>`).join('');
  $('m-estado').textContent = man.estado; $('m-estado').className = 'pill ' + (man.estado === 'verificada' ? 'p-ok' : man.estado === 'en_cargue' ? 'p-info' : 'p-mut');
  $('tb-cons').innerHTML = L.map(l => { const a = S.articulos.find(x => x.sku === l.sku) || {}; const facs = [...new Set(ped.filter(p => S.lineas.some(x => x.pedido_id === p.id && x.sku === l.sku)).map(p => p.numero_factura))]; return `<tr><td class="code">${l.ubicacion || ''}</td><td class="code">${l.sku}</td><td>${esc(a.nombre)}<br><span class="mini">${facs.join(', ')}</span></td><td class="num">${l.requerido}</td><td class="num">${l.cargado}</td><td>${l.cargado >= l.requerido ? '<span class="pill p-ok">OK</span>' : '<span class="pill p-mut">Pendiente</span>'}</td></tr>`; }).join('');
  const all = S.manifiestos.flatMap(m => S.mlineas.filter(l => l.manifiesto_id === m.id).map(l => ({ l, r: S.rutas.find(x => x.id === m.ruta_id) })));
  $('scan-sel').innerHTML = all.map(o => { const a = S.articulos.find(x => x.sku === o.l.sku) || {}; return `<option value="${o.l.sku}">${o.l.sku} · ${esc(a.nombre)} · ${o.r.codigo}${o.r.id !== r.id ? ' (otra ruta)' : ''}</option>`; }).join('');
  $('scan-log').innerHTML = scanLog.map(e => `<div><span>${e.ok ? '✔' : '✖'} ${e.ts.toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit' })}</span> ${esc(e.t)}</div>`).join('') || '<div><span>Sin escaneos todavía.</span></div>';
  const stops = S.paradas.filter(p => p.ruta_id === r.id && p.tipo === 'entrega').sort((a, b) => a.secuencia - b.secuencia); const byC = {};
  stops.forEach(s => { const p = S.pedidos.find(x => x.id === s.pedido_id); if (!p) return; const c = cli(s.cliente_id); const k = c.id; byC[k] = byC[k] || { c, seq: s.secuencia, facs: [], bultos: 0, valor: 0 }; byC[k].facs.push(p.numero_factura); byC[k].bultos += +p.cajas; byC[k].valor += +p.valor; byC[k].seq = Math.min(byC[k].seq, s.secuencia); });
  const det = Object.values(byC).sort((a, b) => a.seq - b.seq);
  $('tb-det').innerHTML = det.map((d, i) => `<tr><td class="num"><b>${det.length - i}</b></td><td class="num">${i + 1}</td><td>${esc(d.c.nombre)}</td><td class="code">${d.facs.join(', ')}</td><td class="num">${d.bultos}</td><td class="num">${fmt(d.valor)}</td><td class="note">${d.facs.length > 1 ? 'Consolidación logística de ' + d.facs.length + ' facturas · ' : ''}${d.c.ventana_inicio ? 'ventana ' + d.c.ventana_inicio + '–' + d.c.ventana_fin + ' · ' : ''}${S.lineas.some(l => d.facs.length && S.pedidos.filter(p => d.facs.includes(p.numero_factura)).some(p => p.id === l.pedido_id) && (S.articulos.find(a => a.sku === l.sku) || {}).fragil) ? 'frágil: dispensadores arriba' : ''}</td></tr>`).join('');
  $('b-liberar').disabled = !(man.estado === 'verificada' && ['publicada', 'en_cargue'].includes(r.estado));
}
const SEG = { chofer: '', ruta: '', estadoRuta: '', estado: '', inc: '' };
const IEST = { registrada: ['Registrada', 'p-warn'], notificada: ['Notificada', 'p-info'], en_correccion: ['En corrección', 'p-info'], pendiente_verificacion: ['Pend. verificación', 'p-vio'], cerrada: ['Cerrada', 'p-ok'], vencida: ['Vencida', 'p-crit'], reabierta: ['Reabierta', 'p-warn'] };
function renderSeguimiento() {
  const activas = S.rutas.filter(r => r.estado !== 'simulada');
  // filtros (conservar selección)
  const fc = $('f-chofer'), fr = $('f-ruta'); const pc = fc.value, pr = fr.value;
  fc.innerHTML = '<option value="">Todos</option>' + [...new Set(activas.map(r => r.conductor))].sort().map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join(''); fc.value = pc;
  fr.innerHTML = '<option value="">Todas</option>' + activas.map(r => `<option value="${r.id}">${r.codigo} · ${(veh(r.vehiculo_id) || {}).placa || ''}</option>`).join(''); fr.value = pr;
  let rutas = activas.filter(r => (!SEG.chofer || r.conductor === SEG.chofer) && (!SEG.ruta || r.id === SEG.ruta) && (!SEG.estadoRuta || r.estado === SEG.estadoRuta));
  const ids = new Set(rutas.map(r => r.id));
  const ent = S.paradas.filter(p => p.tipo === 'entrega' && ids.has(p.ruta_id));
  const incAll = S.incidencias.filter(i => ids.has(i.ruta_id)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const inc = incAll.filter(i => !SEG.inc || (SEG.inc === 'abiertas' ? i.estado !== 'cerrada' : SEG.inc === 'cerrada' ? i.estado === 'cerrada' : i.tipo === SEG.inc));
  const eventos = S.eventos.filter(e => ids.has(e.ruta_id));
  $('seg-kpis').innerHTML = [['Rutas', rutas.length, `${rutas.filter(r => r.estado === 'en_ruta').length} en ruta · ${rutas.filter(r => ['liberada'].includes(r.estado)).length} liberadas · ${rutas.filter(r => ['cerrada', 'conciliada'].includes(r.estado)).length} cerradas`], ['Entregas atendidas', `${ent.filter(p => ['atendida', 'parcial', 'no_entregada'].includes(p.estado)).length}/${ent.length}`, `${ent.filter(p => p.estado === 'parcial').length} parciales · ${ent.filter(p => p.estado === 'no_entregada').length} no entregadas`], ['Incidencias abiertas', incAll.filter(i => i.estado !== 'cerrada').length, `${incAll.filter(i => i.tipo === 'demora').length} demoras · ${incAll.filter(i => i.tipo !== 'demora').length} averías/otros`], ['Eventos recibidos', eventos.length, eventos.filter(e => e.offline).length + ' sincronizados desde cola offline']].map(k => `<div class="tile"><div class="l">${k[0]}</div><div class="v">${k[1]}</div><div class="s">${k[2]}</div></div>`).join('');
  // incidencias
  $('tb-inc').innerHTML = inc.length ? inc.map(i => { const r = S.rutas.find(x => x.id === i.ruta_id) || {}; const pa = S.paradas.find(x => x.id === i.parada_id); const c = pa && pa.cliente_id ? cli(pa.cliente_id) : null; const st = IEST[i.estado] || [i.estado, 'p-mut']; return `<tr><td class="code">${new Date(i.created_at).toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit' })}</td><td class="code"><b style="color:${(veh(r.vehiculo_id) || {}).color}">${r.codigo || ''}</b></td><td>${esc(i.actor || r.conductor || '')}</td><td><span class="pill ${i.tipo === 'demora' ? 'p-warn' : i.tipo === 'accidente' ? 'p-crit' : 'p-info'} nodot">${esc(i.tipo)}</span></td><td>${esc(i.descripcion || '')}</td><td class="num">${i.demora_min ? i.demora_min + '′' : '—'}</td><td class="mini">${c ? esc(c.nombre) : pa ? esc(pa.tipo) : '—'}</td><td><span class="pill ${st[1]}">${st[0]}</span></td><td>${i.estado !== 'cerrada' ? `<button class="btn sec xs" data-inc-close="${i.id}">Cerrar</button>` : ''}</td></tr>`; }).join('') : `<tr><td colspan="9" class="note">Sin incidencias${SEG.inc || SEG.chofer || SEG.ruta ? ' con estos filtros' : ''}.</td></tr>`;
  $('inc-note').textContent = `${inc.length} de ${incAll.length}`;
  document.querySelectorAll('[data-inc-close]').forEach(b => b.onclick = async () => { const i = S.incidencias.find(x => x.id === b.dataset.incClose); await DB.update('incidencias', { id: i.id }, { estado: 'cerrada', cerrada_at: new Date().toISOString() }); await DB.audit('incidencias', 'cierre', `${i.tipo}: ${i.descripcion || ''} · cerrada por torre de control`, ACTOR, false, i.id); toast('Incidencia cerrada'); await refreshLive(); });
  // paradas por ruta
  $('seg-rutas').innerHTML = rutas.length ? rutas.map(r => { const v = veh(r.vehiculo_id) || {}; const st = S.paradas.filter(p => p.ruta_id === r.id && (!SEG.estado || p.estado === SEG.estado)).sort((a, b) => a.secuencia - b.secuencia); const done = S.paradas.filter(p => p.ruta_id === r.id && !['pendiente', 'en_sitio'].includes(p.estado)).length, tot = S.paradas.filter(p => p.ruta_id === r.id).length; return `<div class="card flat veh" style="--vc:${v.color};padding:12px 14px"><div class="hd" style="margin-bottom:6px"><div><b>${r.codigo}</b> · ${v.placa} · ${esc(r.conductor)}${r.ayudante ? ' + ' + esc(r.ayudante) : ''}<div class="mini">${done}/${tot} paradas · salida ${r.salida_at ? new Date(r.salida_at).toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit' }) : r.hora_salida || '—'} · regreso previsto ${r.hora_fin_prevista || '—'}${r.km_real ? ' · ' + f1(r.km_real) + ' km reales' : ''}</div></div><div>${rpill(r.estado)}${r.version > 1 ? ` <span class="pill p-info nodot">v${r.version}</span>` : ''}</div></div><div class="bar" style="margin-bottom:8px"><i style="width:${tot ? done / tot * 100 : 0}%"></i></div><div class="tw"><table><tbody>${st.map(s => { const c = s.cliente_id ? cli(s.cliente_id) : null; return `<tr><td class="num" style="width:30px">${s.secuencia}</td><td>${c ? esc(c.nombre) : esc(s.notas)}${s.checkin_at ? `<div class="mini">check-in ${new Date(s.checkin_at).toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit' })}${s.distancia_checkin_m != null ? ' · ' + Math.round(s.distancia_checkin_m) + ' m' : ''}${s.receptor ? ' · recibe ' + esc(s.receptor) : ''}</div>` : ''}</td><td class="code">${s.eta}</td><td>${stpill(s.estado)}${s.resultado ? ` <div class="mini">${esc(s.resultado)}</div>` : ''}</td></tr>`; }).join('') || '<tr><td class="note">Sin paradas con este estado.</td></tr>'}</tbody></table></div></div>`; }).join('') : '<div class="empty">Ninguna ruta publicada con estos filtros. Aprueba rutas en Planificación y libéralas desde Manifiesto.</div>';
  $('seg-rutas-note').textContent = `${rutas.length} rutas`;
  $('seg-log').innerHTML = eventos.slice(0, 120).map(e => { const r = S.rutas.find(x => x.id === e.ruta_id) || {}; const d = e.detalle || {}; return `<div><span>${new Date(e.created_at).toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit' })} ${r.codigo || ''}</span> <b>${e.tipo}</b> ${esc(d.texto || '')}${e.lat ? ` <span>· GPS ${(+e.lat).toFixed(4)},${(+e.lng).toFixed(4)}</span>` : ''}${e.offline ? ' <span>· offline→sync</span>' : ''} <span>· ${esc(e.actor || '')}</span></div>`; }).join('') || '<div><span>Sin eventos todavía.</span></div>';
  $('seg-note').textContent = (DB.getMode() === 'supabase' ? 'Sondeo cada 10 s' : 'Modo local: mismo navegador') + ` · ${eventos.length} eventos`;
}
function renderCostos() {
  const C = S.costos.map(c => Object.assign({ r: S.rutas.find(r => r.id === c.ruta_id) }, c)).filter(c => c.r);
  if (!C.length) { $('c-kpis').innerHTML = `<div class="empty" style="grid-column:1/-1">${S.rutas.length ? 'Concilia las rutas para calcular costos reales.' : 'Primero planifica y ejecuta las rutas.'}</div>`; $('tb-cost').innerHTML = ''; $('tb-peaje').innerHTML = ''; $('mant').innerHTML = ''; $('chart').innerHTML = ''; return; }
  const tot = C.reduce((s, c) => s + +c.costo_total, 0), ven = C.reduce((s, c) => s + +c.valor_vendido, 0), ent = C.reduce((s, c) => s + +c.entregas, 0), kmr = C.reduce((s, c) => s + +c.km_real, 0), umbral = +R('desviacion_consumo').pct || 15;
  $('c-kpis').innerHTML = [['Costo logístico del día', 'B/. ' + fmt(tot), `${f1(tot / ven * 100)} % sobre B/. ${fmt(ven)} vendidos`], ['Costo por entrega', 'B/. ' + fmt(tot / Math.max(ent, 1)), `${ent} entregas`], ['Costo por km', 'B/. ' + fmt(tot / Math.max(kmr, 1)), `${f1(kmr)} km reales vs ${f1(C.reduce((s, c) => s + +c.km_plan, 0))} planificados`], ['Vehículos con alerta', C.filter(c => +c.desviacion_pct > umbral).length, 'consumo fuera de umbral']].map(k => `<div class="tile"><div class="l">${k[0]}</div><div class="v" style="font-size:22px">${k[1]}</div><div class="s">${k[2]}</div></div>`).join('');
  $('tb-cost').innerHTML = C.map(c => { const v = veh(c.r.vehiculo_id) || {}; return `<tr><td class="code"><b style="color:${v.color}">${c.r.codigo}</b></td><td>${v.placa}</td><td class="num">${f1(c.km_plan)}</td><td class="num">${f1(c.km_real)}</td><td class="num">${f1(c.litros_esperados)}</td><td class="num">${f1(c.litros_reales)}</td><td class="num"><span class="pill ${+c.desviacion_pct > umbral ? 'p-crit' : 'p-ok'} nodot">+${f1(c.desviacion_pct)} %</span></td><td class="num">${fmt(c.costo_peajes)}</td><td class="num">${fmt(c.costo_total)}</td><td class="num">${f1(c.pct_sobre_venta)} %</td><td class="num">${fmt(c.costo_por_entrega)}</td></tr>`; }).join('');
  $('tb-peaje').innerHTML = S.peajes.map(p => { const r = S.rutas.find(x => x.id === p.ruta_id) || {}; const v = veh(r.vehiculo_id) || {}; return `<tr><td class="code">${r.codigo || ''}</td><td class="code">${v.panapass_tag || ''}</td><td>${esc(p.punto)}</td><td class="num">${fmt(p.monto_estimado)}</td><td class="num">${fmt(p.monto_real)}</td><td>${p.fuera_de_ruta ? '<span class="pill p-warn">Fuera de ruta</span>' : '<span class="pill p-ok">Conciliado</span>'}</td></tr>`; }).join('');
  $('mant').innerHTML = C.filter(c => +c.desviacion_pct > umbral).map(c => { const v = veh(c.r.vehiculo_id) || {}; return `<div class="alert crit"><span class="dot"></span><div><b>${v.placa} ${v.nombre}: ${f1(+v.km_por_litro / (1 + c.desviacion_pct / 100))} km/L vs ${v.km_por_litro} esperado</b><small>Orden de mantenimiento MT-${hoy().replace(/-/g, '').slice(2)}-${v.placa.slice(-3)} creada · revisar inyectores y presión de llantas · próximo servicio adelantado</small></div></div>`; }).join('') || '<div class="note">Sin desviaciones fuera de umbral.</div>';
  const W = 520, H = 260, pl = 48, pb = 44, pt = 18, pr = 12, iw = (W - pl - pr) / C.length, max = Math.ceil(Math.max(...C.map(c => Math.max(+c.litros_esperados, +c.litros_reales))) / 5) * 5 || 5;
  let s = `<style>.ct{font:11px var(--sans);fill:#64748B}.cv{font:11px var(--mono);fill:#0F172A;font-weight:700}</style>`;
  for (let i = 0; i <= 4; i++) { const y = pt + (H - pt - pb) * (1 - i / 4); s += `<line x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}" stroke="#E2E8E4"/><text class="ct" x="${pl - 6}" y="${y + 4}" text-anchor="end">${Math.round(max * i / 4)}</text>`; }
  C.forEach((c, i) => { const v = veh(c.r.vehiculo_id) || {}; const x0 = pl + iw * i + iw * .15, bw = iw * .3, h1 = (H - pt - pb) * c.litros_esperados / max, h2 = (H - pt - pb) * c.litros_reales / max, base = H - pb; s += `<rect x="${x0}" y="${base - h1}" width="${bw}" height="${h1}" fill="#CBD5E1" rx="3"/><rect x="${x0 + bw + 4}" y="${base - h2}" width="${bw}" height="${h2}" fill="${+c.desviacion_pct > umbral ? '#DC2626' : v.color || '#16A34A'}" rx="3"/><text class="cv" x="${x0 + bw + 4 + bw / 2}" y="${base - h2 - 5}" text-anchor="middle">${f1(c.litros_reales)}</text><text class="ct" x="${pl + iw * i + iw / 2}" y="${H - pb + 16}" text-anchor="middle">${v.placa}</text><text class="ct" x="${pl + iw * i + iw / 2}" y="${H - pb + 31}" text-anchor="middle">${c.r.codigo} · +${f1(c.desviacion_pct)} %</text>`; });
  s += `<text class="ct" x="${pl}" y="${pt - 5}">Litros · gris = esperado, color = real</text>`; $('chart').innerHTML = s;
}
function renderReglas() {
  $('tb-reglas').innerHTML = S.reglasRows.map(r => { const v = r.valor || {}; const k = Object.keys(v)[0]; const val = v[k]; return `<tr><td><b>${esc(r.descripcion || r.clave)}</b><br><span class="mini code">${r.clave} · ${esc(r.actualizado_por || '')}</span></td><td><input ${typeof val === 'number' ? 'type="number"' : ''} data-r="${r.clave}" data-k="${k}" value="${esc(val)}" style="width:110px"></td><td class="note">${esc(r.accion || '')}</td></tr>`; }).join('');
  document.querySelectorAll('[data-r]').forEach(i => i.onchange = async () => { const row = S.reglasRows.find(r => r.clave === i.dataset.r); const old = row.valor[i.dataset.k]; const nv = typeof old === 'number' ? +i.value : i.value; const nuevo = Object.assign({}, row.valor, { [i.dataset.k]: nv }); await DB.update('reglas', { id: row.id }, { valor: nuevo, actualizado_por: 'Admin DGP', updated_at: new Date().toISOString() }); await DB.audit('reglas', 'cambio', `${row.clave}.${i.dataset.k}: ${old} → ${nv} · motivo: ajuste operativo · vigente desde hoy`, 'Admin DGP', false, row.id); if (row.clave === 'cap_valor') $('sim-cap').value = nv; toast('Regla actualizada y auditada'); await loadAll(); render(); });
  $('aud').innerHTML = S.auditoria.slice(0, 200).map(a => `<div><span>${new Date(a.created_at).toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span> <b>${esc(a.entidad)}</b> ${esc(a.accion)} · ${esc(a.detalle)} <span>· ${a.automatico ? 'automático' : esc(a.actor)}</span></div>`).join(''); $('aud-n').textContent = `${S.auditoria.length} eventos`;
}
const CAT = { clientes: ['codigo', 'nombre', 'zona_codigo', 'direccion', 'lat', 'lng', 'geo_estado', 'ventana_inicio', 'ventana_fin', 'tiempo_servicio_min', 'ejecutivo', 'credito_bloqueado', 'zoho_account_id'], articulos: ['sku', 'nombre', 'categoria', 'precio', 'peso_kg', 'volumen_m3', 'unidades_por_caja', 'fragil', 'ubicacion', 'codigo_barras'], vehiculos: ['placa', 'nombre', 'tipo', 'cap_valor', 'cap_peso_kg', 'cap_volumen_m3', 'cap_cajas', 'cap_posiciones', 'km_por_litro', 'panapass_tag', 'conductor', 'ayudante', 'color'], personas: ['nombre', 'rol', 'telefono', 'pin'], pedidos: ['numero_so', 'numero_factura', 'cliente_codigo', 'fecha', 'valor', 'peso_kg', 'volumen_m3', 'cajas', 'prioridad', 'estado'] };
const KEY = { clientes: 'codigo', articulos: 'sku', vehiculos: 'placa', personas: 'nombre', pedidos: 'numero_so' };
function renderCatalogo() {
  const t = S.catTab; const cols = CAT[t]; let rows = t === 'pedidos' ? S.pedidos.map(p => Object.assign({}, p, { cliente_codigo: (cli(p.cliente_id) || {}).codigo })) : S[t];
  $('cat-table').querySelector('thead').innerHTML = '<tr>' + cols.map(c => `<th>${c}</th>`).join('') + '</tr>';
  $('cat-table').querySelector('tbody').innerHTML = rows.map(r => '<tr>' + cols.map(c => `<td class="${typeof r[c] === 'number' ? 'num' : ''}">${c === 'geo_estado' ? `<span class="badge-geo">${esc(r[c])}</span>` : c === 'color' ? `<i style="display:inline-block;width:14px;height:14px;border-radius:4px;background:${r[c]}"></i>` : esc(r[c] === true ? 'sí' : r[c] === false ? 'no' : r[c] ?? '')}</td>`).join('') + '</tr>').join('');
  const pend = S.clientes.filter(c => c.lat == null || ['pendiente', 'dudosa'].includes(c.geo_estado)).length;
  $('cat-note').textContent = `${rows.length} registros` + (t === 'clientes' ? ` · ${pend} direcciones pendientes de geocodificar/validar · ${S.clientes.filter(c => c.geo_estado === 'aproximada').length} con coordenada aproximada` : '');
  $('templates').innerHTML = Object.keys(CAT).map(k => `<button class="btn sec sm" data-tpl="${k}">${k}.csv</button>`).join('');
  document.querySelectorAll('[data-tpl]').forEach(b => b.onclick = () => download(`${b.dataset.tpl}.csv`, Papa.unparse({ fields: CAT[b.dataset.tpl], data: [] })));
  renderIaDir();
}
function download(name, text) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; a.click(); }
async function importCSV(file) {
  const t = S.catTab; Papa.parse(file, { header: true, skipEmptyLines: true, dynamicTyping: true, complete: async res => {
    const rows = res.data; let n = 0;
    if (t === 'pedidos') { const byCod = {}; S.clientes.forEach(c => byCod[c.codigo] = c.id); const ped = rows.filter(r => byCod[r.cliente_codigo]).map(r => ({ numero_so: String(r.numero_so), numero_factura: r.numero_factura, cliente_id: byCod[r.cliente_codigo], fecha: r.fecha || hoy(), prioridad: r.prioridad || 3, valor: +r.valor, peso_kg: +r.peso_kg || 0, volumen_m3: +r.volumen_m3 || 0, cajas: +r.cajas || 0, estado: 'pendiente_validar' })); await DB.upsert('pedidos', ped, 'numero_so'); n = ped.length; }
    else { const clean = rows.map(r => { const o = {}; CAT[t].forEach(c => { if (r[c] !== undefined && r[c] !== '') o[c] = r[c]; }); if (t === 'clientes' && (o.lat == null)) o.geo_estado = 'pendiente'; return o; }).filter(o => o[KEY[t]]); await DB.upsert(t, clean, KEY[t]); n = clean.length; }
    await DB.audit(t, 'importacion_csv', `${n} registros importados desde ${file.name}`, 'Admin DGP', false); toast(`${n} registros importados`); await loadAll(); render(); } });
}
async function geocodePendientes() {
  const pend = S.clientes.filter(c => c.lat == null || c.geo_estado === 'pendiente'); if (!pend.length) { toast('No hay direcciones pendientes'); return; }
  toast(`Geocodificando ${pend.length} direcciones (1/s)…`); let ok = 0;
  for (const c of pend) { const g = await GEO.geocode(c.direccion || c.nombre); if (g) { await DB.update('clientes', { id: c.id }, { lat: g.lat, lng: g.lng, geo_estado: 'automatica' }); ok++; } await GEO.sleep(1100); }
  await DB.audit('clientes', 'geocodificacion', `${ok}/${pend.length} direcciones geocodificadas con OpenStreetMap`, 'Admin DGP', false); toast(`${ok} direcciones geocodificadas`); await loadAll(); render();
}
function renderConfig() {
  const cfg = DB.getCfg(); $('cfg-url').value = cfg.url || ''; $('cfg-key').value = cfg.key || '';
  const m = DB.getMode(); $('mode-txt').textContent = m === 'supabase' ? 'Supabase conectado' : 'Modo local (este navegador)'; $('mode-dot').className = 'dot' + (m === 'supabase' ? '' : ' off');
  $('cfg-msg').textContent = m === 'supabase' ? `Conectado a ${cfg.url}` : (DB.lastError ? 'No se pudo conectar: ' + DB.lastError + ' · usando modo local' : 'Sin conexión configurada · modo local');
  const ai = AI.cfg(); $('ai-endpoint').value = ai.endpoint || ''; $('ai-key').value = ai.key || ''; $('ai-model').value = ai.model || ''; $('ai-msg').textContent = 'Modo actual: ' + AI.modo();
  const url = new URL('conductor.html', location.href).href; $('url-conductor').textContent = url;
  if (!$('qr').dataset.done && window.QRCode) { new QRCode($('qr'), { text: url, width: 140, height: 140 }); $('qr').dataset.done = 1; }
}
// ===================== MAPA =====================
function initMap() {
  map = L.map('map', { zoomControl: true, scrollWheelZoom: false }).setView([8.99, -79.55], 11);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', maxZoom: 19 }).addTo(map);
  layers.clientes = L.layerGroup().addTo(map); layers.bodega = L.layerGroup().addTo(map); layers.rutasG = L.layerGroup().addTo(map); layers.vehG = L.layerGroup().addTo(map);
}
function drawMap() {
  if (!map) return; layers.clientes.clearLayers(); layers.bodega.clearLayers(); layers.rutasG.clearLayers(); layers.vehG.clearLayers();
  const B = S.bodega; if (B) L.marker([+B.lat, +B.lng], { icon: L.divIcon({ className: '', html: '<div class="mk-bodega"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 9l9-6 9 6v11H3z"/><path d="M9 20v-7h6v7"/></svg></div>', iconSize: [34, 34], iconAnchor: [17, 17] }), zIndexOffset: 1000 }).bindPopup(`<b>${B.nombre}</b>${B.direccion}`).addTo(layers.bodega);
  const rutaDeCli = {}; S.pedidos.forEach(p => { if (p.ruta_id) rutaDeCli[p.cliente_id] = S.rutas.find(r => r.id === p.ruta_id); });
  S.clientes.forEach(c => { if (c.lat == null) return; const ps = S.pedidos.filter(p => p.cliente_id === c.id); const st = ps[0] ? ps[0].estado : ''; const r = rutaDeCli[c.id]; const v = r ? veh(r.vehiculo_id) : null; if (r && hidden.has(r.id)) return;
    const col = st === 'en_excepcion' ? '#DC2626' : v ? v.color : ['diferido', 'pendiente_autorizacion'].includes(st) ? '#D97706' : st === 'elegible' ? '#16A34A' : '#94A3B8';
    const seq = r ? (S.paradas.find(p => p.ruta_id === r.id && p.cliente_id === c.id) || {}).secuencia : null; const parada = r ? S.paradas.find(p => p.ruta_id === r.id && p.cliente_id === c.id) : null;
    const done = parada && ['atendida', 'parcial', 'no_entregada'].includes(parada.estado);
    L.marker([+c.lat, +c.lng], { icon: L.divIcon({ className: '', html: `<div class="mk" style="background:${col};${done ? 'opacity:.55' : ''}"><span>${seq || ''}</span></div>`, iconSize: [26, 26], iconAnchor: [13, 26], popupAnchor: [0, -24] }) }).bindPopup(`<b>${esc(c.nombre)}</b>${esc(c.direccion || '')}<br>${ps.map(p => `${p.numero_so} · B/. ${fmt(p.valor)} · ${(EST[p.estado] || [p.estado])[0]}`).join('<br>')}${r ? `<br><b style="color:${col}">${r.codigo} · parada ${seq}${parada ? ' · ETA ' + parada.eta : ''}</b>` : ''}${c.geo_estado !== 'validada' ? `<br><span style="color:#64748B">coordenada ${c.geo_estado} · validar</span>` : ''}`).addTo(layers.clientes); });
  S.rutas.forEach(r => { if (hidden.has(r.id)) return; const v = veh(r.vehiculo_id) || {}; const st = S.paradas.filter(p => p.ruta_id === r.id).sort((a, b) => a.secuencia - b.secuencia); const pts = r.geometria && r.geometria.length ? r.geometria : [[+B.lat, +B.lng], ...st.map(s => [+s.lat, +s.lng]), [+B.lat, +B.lng]];
    L.polyline(pts, { color: '#fff', weight: 7, opacity: .9 }).addTo(layers.rutasG); L.polyline(pts, { color: v.color || '#16A34A', weight: 4, opacity: .95, dashArray: r.estado === 'simulada' ? '8 8' : null }).bindPopup(`<b>${r.codigo} · ${v.placa}</b>${r.conductor} · ${f1(r.km_plan)} km · ${st.filter(s => s.tipo === 'entrega').length} entregas`).addTo(layers.rutasG);
    if (['liberada', 'en_ruta'].includes(r.estado)) { const pos = S.posiciones.filter(p => p.ruta_id === r.id).slice(-1)[0]; const cur = st.find(s => s.estado === 'en_sitio') || st.filter(s => ['atendida', 'parcial', 'no_entregada'].includes(s.estado)).slice(-1)[0]; const ll = pos ? [+pos.lat, +pos.lng] : cur ? [+cur.lat, +cur.lng] : [+B.lat, +B.lng]; L.marker(ll, { icon: L.divIcon({ className: '', html: `<div class="mk-veh" style="background:${v.color}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 900 }).bindPopup(`<b>${v.placa} · ${r.conductor}</b>${pos ? 'Posición GPS ' + new Date(pos.ts).toLocaleTimeString('es-PA') : 'Última parada conocida'}`).addTo(layers.vehG); } });
  $('map-chips').innerHTML = `<span class="chip"><i style="background:#0F172A"></i>Bodega</span><span class="chip"><i style="background:#DC2626"></i>Excepción</span>` + S.rutas.map(r => { const v = veh(r.vehiculo_id) || {}; return `<span class="chip ${hidden.has(r.id) ? 'off' : ''}" data-rt="${r.id}"><i style="background:${v.color}"></i>${r.codigo} ${v.placa}</span>`; }).join('');
  document.querySelectorAll('[data-rt]').forEach(c => c.onclick = () => { hidden.has(c.dataset.rt) ? hidden.delete(c.dataset.rt) : hidden.add(c.dataset.rt); drawMap(); });
  if (!drawMap._fit && S.clientes.length) { const pts = S.clientes.filter(c => c.lat != null).map(c => [+c.lat, +c.lng]); if (B) pts.push([+B.lat, +B.lng]); map.fitBounds(pts, { padding: [24, 24] }); drawMap._fit = true; }
}
// ===================== EVENTOS UI =====================
document.querySelectorAll('.nav button').forEach(b => b.onclick = () => nav(b.dataset.v));
$('ped-tabs').querySelectorAll('button').forEach(b => b.onclick = () => { S.pedTab = b.dataset.t; $('ped-tabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); render(); });
$('cat-tabs').querySelectorAll('button').forEach(b => b.onclick = () => { S.catTab = b.dataset.t; $('cat-tabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); renderCatalogo(); });
$('b-validar').onclick = validar; $('b-plan').onclick = planificar; $('b-aprobar').onclick = aprobar; $('b-liberar').onclick = liberar; $('m-ruta').onchange = renderManif; $('b-cerrar').onclick = cerrar;
$('b-scan').onclick = () => { const v = $('scan-in').value.trim(); if (v) scan(v, $('m-ruta').value); $('scan-in').value = ''; }; $('scan-in').onkeydown = e => { if (e.key === 'Enter') $('b-scan').click(); };
$('b-scan-sel').onclick = () => scan($('scan-sel').value, $('m-ruta').value);
$('b-scan-all').onclick = async () => { const man = S.manifiestos.find(m => m.ruta_id === $('m-ruta').value); if (!man) return; for (const l of S.mlineas.filter(x => x.manifiesto_id === man.id && x.cargado < x.requerido)) await scan(l.sku, $('m-ruta').value); await loadAll(); render(); };
$('b-print').onclick = () => window.print();
[['f-chofer', 'chofer'], ['f-ruta', 'ruta'], ['f-estado-ruta', 'estadoRuta'], ['f-estado', 'estado'], ['f-inc', 'inc']].forEach(([id, k]) => $(id).onchange = () => { SEG[k] = $(id).value; renderSeguimiento(); });
$('f-clear').onclick = () => { Object.keys(SEG).forEach(k => SEG[k] = ''); ['f-chofer', 'f-ruta', 'f-estado-ruta', 'f-estado', 'f-inc'].forEach(id => $(id).value = ''); renderSeguimiento(); };
$('b-geocode').onclick = geocodePendientes; $('csv-file').onchange = e => { if (e.target.files[0]) importCSV(e.target.files[0]); e.target.value = ''; };
$('b-export').onclick = () => download(`${S.catTab}_${hoy()}.csv`, Papa.unparse({ fields: CAT[S.catTab], data: (S.catTab === 'pedidos' ? S.pedidos.map(p => Object.assign({}, p, { cliente_codigo: (cli(p.cliente_id) || {}).codigo })) : S[S.catTab]).map(r => CAT[S.catTab].map(c => r[c])) }));
$('b-cfg').onclick = () => { DB.saveCfg({ url: $('cfg-url').value.trim(), key: $('cfg-key').value.trim() }); location.reload(); };
$('b-cfg-local').onclick = () => { DB.saveCfg({}); location.reload(); };
$('b-ai-save').onclick = () => { AI.save({ endpoint: $('ai-endpoint').value.trim(), key: $('ai-key').value.trim(), model: $('ai-model').value.trim() }); $('ai-msg').textContent = 'Guardado · modo ' + AI.modo(); toast('Configuración de IA guardada'); };
$('b-ia-dir').onclick = iaDirecciones; $('b-ia-tri').onclick = iaTriageTodas;
$('b-reset').onclick = async () => { if (!confirm('¿Reiniciar la operación del día? Se borran rutas, manifiestos, eventos y costos.')) return; await DB.resetOperacion(); scanLog.length = 0; drawMap._fit = false; toast('Operación reiniciada'); await loadAll(); render(); nav('torre'); };
// ===================== INICIO =====================
(async function () {
  await DB.init(); initMap(); await loadAll(); render();
  $('ctx-sync').textContent = DB.getMode() === 'supabase' ? 'Sincronizado con Supabase' : 'Modo local';
  setInterval(() => { if (['torre', 'seguimiento'].includes(S.view) && !document.hidden) refreshLive().catch(console.warn); }, DB.getMode() === 'supabase' ? 10000 : 4000);
})();
