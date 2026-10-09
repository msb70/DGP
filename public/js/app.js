/* DGP · Torre de Control · lógica de la aplicación */
const $ = id => document.getElementById(id);
const fmt = n => (+n || 0).toLocaleString('es-PA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const f1 = n => (+n || 0).toLocaleString('es-PA', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const hhmm = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
const tmin = s => { if (!s) return null; const [a, b] = s.split(':').map(Number); return a * 60 + b; };
const hoy = () => new Date().toISOString().slice(0, 10);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/* Usuario actual y permisos por rol (A2/A5). En producción: inicio de sesión con Google Workspace de DGP (I1) vía Supabase Auth. */
let ACTOR = (() => { try { return localStorage.getItem('dgp_user') || 'Lorena Ábrego'; } catch (e) { return 'Lorena Ábrego'; } })();
const ROL_N = { admin: 'Administración', planificador: 'Planificación', verificador: 'Verificador', encargado_bodega: 'Encargado de bodega', bodega: 'Bodega', gestion_documental: 'Gestión documental', ejecutivo: 'Ejecutivo de cuenta', gerente_comercial: 'Gerente comercial', facturacion: 'Facturación', cxc: 'Cuentas por cobrar', mantenimiento: 'Mantenimiento', gerente_operaciones: 'Gerente de operaciones', conductor: 'Conductor', ayudante: 'Ayudante' };
const PERM = { reglas: ['admin', 'facturacion', 'bodega', 'encargado_bodega'], planificar: ['planificador', 'admin', 'gerente_operaciones', 'encargado_bodega'], verificar: ['verificador', 'encargado_bodega', 'admin'], gd: ['encargado_bodega', 'gestion_documental', 'admin'], promesa: ['ejecutivo', 'cxc', 'gerente_comercial', 'admin'], incentivos: ['gerente_operaciones', 'admin', 'encargado_bodega'], costos: ['admin', 'facturacion', 'bodega', 'encargado_bodega', 'gerente_operaciones', 'gerente_comercial', 'planificador'] };
const PROD = !!(window.DGP_CONFIG && window.DGP_CONFIG.produccion);
/* v3: en producción los permisos vienen del perfil (Supabase Auth + roles/permisos en la base). Claves de la v2 → permiso. */
const PERM_MAP = { reglas: 'reglas.editar', planificar: 'planificar', verificar: 'verificar', gd: 'gd', promesa: 'pedidos.promesa', incentivos: 'incentivos.gestionar', costos: 'costos.gestionar' };
const DEMO_LIBRE = ['pedidos.validar', 'manifiesto.cargar', 'catalogo.editar', 'seguimiento.incidencias', 'ia.usar', 'notificaciones.enviar', 'sistema.reset', 'ver.config'];
const rolActual = () => Auth.activo ? Auth.perfil.rol : ((S.personas.find(p => p.nombre === ACTOR) || {}).rol || 'admin');
const puede = k => { const p = PERM_MAP[k] || k; if (Auth.activo) return Auth.puede(p); if (PERM[k]) return PERM[k].includes(rolActual()); return DEMO_LIBRE.includes(p) || p.startsWith('ver.') ? true : rolActual() === 'admin'; };
function exige(k) { if (puede(k)) return true; toast(Auth.activo ? `Tu rol (${Auth.perfil.rol_nombre || ROL_N[rolActual()] || rolActual()}) no tiene permiso para esta acción.` : `Tu rol (${ROL_N[rolActual()] || rolActual()}) no puede hacer esto. Cambia de usuario abajo a la izquierda.`); return false; }
let S = { zonas: [], clientes: [], articulos: [], vehiculos: [], personas: [], reglas: {}, reglasRows: [], pedidos: [], lineas: [], rutas: [], paradas: [], manifiestos: [], mlineas: [], eventos: [], alertas: [], auditoria: [], incidencias: [], costos: [], peajes: [], posiciones: [], bodega: null, pedTab: 'todos', catTab: 'clientes', view: 'torre' };
let map, layers = { rutas: {}, clientes: null, bodega: null, veh: {} }, hidden = new Set();
const IA = { dir: {}, tri: {}, busy: false };
function modal(html) { $('modal-body').classList.remove('wide'); $('modal-body').innerHTML = html; $('modal').classList.add('on'); $('modal').onclick = e => { if (e.target === $('modal')) $('modal').classList.remove('on'); }; }
function closeModal() { $('modal').classList.remove('on'); }
const R = k => S.reglas[k] || {};
const cli = id => S.clientes.find(c => c.id === id);
const veh = id => S.vehiculos.find(v => v.id === id);
const zona = code => S.zonas.find(z => z.codigo === code) || { nombre: code || 'Sin zona', color: '#64748B' }; // clientes de Zoho llegan sin zona
const toast = t => { const e = $('toast'); e.textContent = t; e.classList.add('on'); clearTimeout(e._t); e._t = setTimeout(() => e.classList.remove('on'), 3000); };

// ===================== CARGA =====================
/* Producción: la operación se carga por ventana (rutas y pedidos abiertos o de los últimos días) y los historiales
   por los últimos N registros, para que la torre no se vuelva más lenta cada día. En demo se carga todo como en la v2. */
const diasAtras = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
async function porIds(table, col, ids, order) { if (!ids.length) return []; const out = []; for (let i = 0; i < ids.length; i += 120) out.push(...await DB.all(table, { [col]: ids.slice(i, i + 120) }, order)); if (order) out.sort((a, b) => (a[order] > b[order] ? 1 : a[order] < b[order] ? -1 : 0)); return out; }
const ABIERTOS = '(pendiente_validar,elegible,en_excepcion,planificado,pendiente_autorizacion,diferido)';
async function cargarOperacion() {
  if (!PROD || DB.getMode() !== 'supabase') {
    const [pedidos, lineas, rutas, paradas, manifiestos, mlineas, costos, peajes, paquetes, abast] = await Promise.all([DB.all('pedidos', null, 'numero_so'), DB.all('pedido_lineas'), DB.all('rutas', null, 'codigo'), DB.all('paradas', null, 'secuencia'), DB.all('manifiestos'), DB.all('manifiesto_lineas'), DB.all('costos_ruta'), DB.all('peajes'), DB.all('paquetes', null, 'numero'), DB.all('abastecimientos')]);
    return { pedidos, lineas, rutas, paradas, manifiestos, mlineas, costos, peajes, paquetes, abast };
  }
  const d = diasAtras(+(R('ventana_operacion').dias || 3));
  const [rutas, pedidos] = await Promise.all([DB.all('rutas', null, 'codigo', { or: `fecha.gte.${d},estado.not.in.(cerrada,conciliada)` }), DB.all('pedidos', null, 'numero_so', { or: `fecha.gte.${d},estado.in.${ABIERTOS}` })]);
  const rid = rutas.map(r => r.id), pid = pedidos.map(p => p.id);
  const [paradas, manifiestos, costos, peajes, paquetes, abast, lineas] = await Promise.all([porIds('paradas', 'ruta_id', rid, 'secuencia'), porIds('manifiestos', 'ruta_id', rid), porIds('costos_ruta', 'ruta_id', rid), porIds('peajes', 'ruta_id', rid), porIds('paquetes', 'ruta_id', rid, 'numero'), porIds('abastecimientos', 'ruta_id', rid), porIds('pedido_lineas', 'pedido_id', pid)]);
  const mlineas = await porIds('manifiesto_lineas', 'manifiesto_id', manifiestos.map(m => m.id));
  return { pedidos, lineas, rutas, paradas, manifiestos, mlineas, costos, peajes, paquetes, abast };
}
const hist = (t, o, n, gte) => PROD && DB.getMode() === 'supabase' ? DB.recent(t, o, n, gte) : DB.all(t, null, o);
async function loadAll() {
  const reglas = await DB.all('reglas');
  S.integraciones = DB.getMode() === 'supabase' ? await DB.all('integraciones').catch(() => []) : []; S.reglasRows = reglas; S.reglas = {}; reglas.forEach(r => S.reglas[r.clave] = r.valor);
  const d = diasAtras(3);
  const [bod, zonas, clientes, articulos, vehiculos, personas, op, eventos, alertas, auditoria, posiciones, actas, incentivos, notificaciones] = await Promise.all([
    DB.all('bodegas'), DB.all('zonas'), DB.all('clientes', null, 'codigo'), DB.all('articulos', null, 'sku'), DB.all('vehiculos', null, 'placa'), DB.all('personas', null, 'nombre'), cargarOperacion(),
    hist('eventos', 'created_at', 1500, { created_at: d }), hist('alertas', 'created_at', 400), puede('ver.reglas') || puede('ver.usuarios') || puede('ver.incent') || !Auth.activo ? hist('auditoria', 'created_at', 600) : Promise.resolve([]),
    hist('posiciones', 'ts', 4000, { ts: diasAtras(1) }), hist('actas_gd', 'created_at', 200), PROD && DB.getMode() === 'supabase' ? DB.all('incentivos', null, 'fecha', { gte: { fecha: diasAtras(120) } }) : DB.all('incentivos', null, 'fecha'), hist('notificaciones', 'created_at', 600)]);
  const { pedidos, lineas, rutas, paradas, manifiestos, mlineas, costos, peajes, paquetes, abast } = op;
  S.bodegas = bod; S.bodega = bod.find(b => b.codigo === 'VA') || bod[0]; S.paquetes = paquetes; S.actas = actas.reverse(); S.incentivos = incentivos; S.notificaciones = notificaciones.reverse(); S.abast = abast; S.zonas = zonas; S.clientes = clientes; S.articulos = articulos; S.vehiculos = vehiculos; S.personas = personas;
  S.pedidos = pedidos; S.lineas = lineas; S.rutas = rutas; S.paradas = paradas; S.manifiestos = manifiestos; S.mlineas = mlineas; S.eventos = eventos.reverse(); S.alertas = alertas.reverse(); S.auditoria = auditoria.reverse(); S.incidencias = await (PROD && DB.getMode() === 'supabase' ? porIds('incidencias', 'ruta_id', rutas.map(r => r.id)) : DB.all('incidencias')); S.costos = costos; S.peajes = peajes; S.posiciones = posiciones;
}
async function refreshLive() { // sondeo ligero para seguimiento
  const [op, eventos, alertas, posiciones, notificaciones] = await Promise.all([cargarOperacion(), hist('eventos', 'created_at', 1500, { created_at: diasAtras(3) }), hist('alertas', 'created_at', 400), hist('posiciones', 'ts', 4000, { ts: diasAtras(1) }), hist('notificaciones', 'created_at', 600)]);
  const incidencias = await (PROD && DB.getMode() === 'supabase' ? porIds('incidencias', 'ruta_id', op.rutas.map(r => r.id)) : DB.all('incidencias'));
  S.paquetes = op.paquetes; S.notificaciones = notificaciones.reverse(); S.paradas = op.paradas; S.rutas = op.rutas; S.eventos = eventos.reverse(); S.alertas = alertas.reverse(); S.posiciones = posiciones; S.pedidos = op.pedidos; S.incidencias = incidencias;
  $('ctx-sync').textContent = 'Actualizado ' + new Date().toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  render();
}

// ===================== VALIDACIÓN =====================
async function validar() {
  if (!exige('pedidos.validar')) return;
  const min = +R('monto_minimo').valor || 40; const byCli = {}; const upd = [];
  S.pedidos.forEach(p => { if (['planificado', 'entregado', 'parcial', 'no_entregado', 'cancelado'].includes(p.estado)) return; p.estado = 'elegible'; p.causa = null; p.grupo = null; (byCli[p.cliente_id] = byCli[p.cliente_id] || []).push(p); });
  const nuevasAlertas = [];
  Object.values(byCli).forEach(ps => {
    const c = cli(ps[0].cliente_id); const tot = ps.reduce((s, p) => s + +p.valor, 0);
    ps.forEach(p => {
      if (c.credito_bloqueado && !p.promesa_pago) { p.estado = 'en_excepcion'; p.causa = `Crédito: antigüedad de saldo o límite adicional excedido en Zoho Books · lo libera ${c.ejecutivo} registrando la promesa de pago`; nuevasAlertas.push(['credito', 'alta', `${p.numero_so} · ${c.nombre}`, p.causa, c.ejecutivo]); }
      else if (c.credito_bloqueado && p.promesa_pago) { p.causa = `Liberado con promesa de pago de ${p.promesa_pago.ejecutivo} para el ${p.promesa_pago.fecha}`; }
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

async function promesaPago(pedId) {
  const p = S.pedidos.find(x => x.id === pedId); const c = cli(p.cliente_id);
  modal(`<div class="hd"><div><h2>Promesa de pago · ${esc(c.nombre)}</h2><div class="mini">${p.numero_so} · ${p.numero_factura} · B/. ${fmt(p.valor)} · ejecutivo ${esc(c.ejecutivo)}</div></div></div>
  <div class="note" style="margin-bottom:10px">Cuestionario D3: el crédito se bloquea por antigüedad o límite adicional; lo libera el ejecutivo responsable de la cuenta llenando la promesa de pago. En producción dispara el flujo de aprobación existente en Zoho.</div>
  <div class="grid g2" style="gap:10px"><label class="f">Fecha comprometida<input type="date" id="pp-f" value="${new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)}"></label><label class="f">Monto B/.<input type="number" id="pp-m" step="0.01" value="${(+p.valor).toFixed(2)}"></label></div>
  <label class="f" style="margin-top:8px">Nota<textarea id="pp-n" rows="2">Cliente confirma pago por transferencia.</textarea></label>
  <div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn sec" id="pp-x">Cancelar</button><button class="btn" id="pp-ok">Registrar y liberar</button></div>`);
  $('pp-x').onclick = closeModal;
  $('pp-ok').onclick = async () => { if (!exige('promesa')) return; const pp = { ejecutivo: ACTOR, fecha: $('pp-f').value, monto: +$('pp-m').value, nota: $('pp-n').value, ts: new Date().toISOString() };
    for (const x of S.pedidos.filter(x => x.cliente_id === p.cliente_id && x.estado === 'en_excepcion')) await DB.update('pedidos', { id: x.id }, { promesa_pago: pp, estado: 'elegible', causa: `Liberado con promesa de pago de ${ACTOR} para el ${pp.fecha}` });
    await DB.notificar('correo', 'Cuentas por cobrar', 'cxc', `Promesa de pago · ${c.nombre}`, `${ACTOR} registró promesa de pago de B/. ${fmt(pp.monto)} para el ${pp.fecha} y liberó ${p.numero_so}. ${pp.nota}`, 'liberación de crédito (D3)');
    await DB.audit('pedidos', 'promesa_pago', `${c.nombre}: promesa B/. ${fmt(pp.monto)} al ${pp.fecha} · crédito liberado`, ACTOR, false, p.id); closeModal(); toast('Crédito liberado con promesa de pago'); await loadAll(); render(); };
}
// ===================== PLANIFICACIÓN =====================
/* Cuestionario DGP (D1/D2): el valor NO es un tope. Es la venta MÍNIMA que debe llevar la ruta (panel 2.500, camión 5.000).
   Lo que limita la carga es el espacio (m³, cajas) y el peso. Urgencia y horario ordenan (D4). */
const minimoDe = v => +(v && v.min_valor) || +(R('minimo_ruta')[v && v.tipo === 'camion' ? 'camion' : 'panel']) || 2500;
const tipoVeh = t => ({ camion: 'Camión', panel_alta: 'Panel capota alta', panel_baja: 'Panel capota baja' }[t] || t || '');
function cabe(r, v, p) { return { vol: +r.volumen_m3 + +p.volumen_m3 <= +v.cap_volumen_m3 + 1e-9, peso: +r.peso_kg + +p.peso_kg <= +v.cap_peso_kg + 1e-9, cajas: +r.cajas + +p.cajas <= +v.cap_cajas }; }
const QN = { vol: 'volumen', peso: 'peso', cajas: 'cajas' };
const ordenPedidos = (a, b) => (+a.prioridad || 3) - (+b.prioridad || 3) || (cli(a.cliente_id).ventana_inicio ? 0 : 1) - (cli(b.cliente_id).ventana_inicio ? 0 : 1) || a.numero_so.localeCompare(b.numero_so);
function totalesDe(peds) { return peds.reduce((t, p) => ({ valor: t.valor + +p.valor, peso_kg: t.peso_kg + +p.peso_kg, volumen_m3: t.volumen_m3 + +p.volumen_m3, cajas: t.cajas + +p.cajas }), { valor: 0, peso_kg: 0, volumen_m3: 0, cajas: 0 }); }
async function planificar() {
  if (!exige('planificar')) return;
  const elegibles = S.pedidos.filter(p => ['elegible', 'diferido'].includes(p.estado) && !p.ruta_id);
  if (!elegibles.length) { toast('No hay pedidos elegibles sin ruta. Valida primero.'); return; }
  $('plan-msg').innerHTML = '<div class="note">Calculando rutas y trazando calles con OSRM…</div>';
  const viejas = S.rutas.filter(r => r.estado === 'simulada');
  for (const r of viejas) { await DB.update('pedidos', { ruta_id: r.id }, { ruta_id: null, estado: 'elegible' }); await DB.remove('paradas', { ruta_id: r.id }); await DB.remove('rutas', { id: r.id }); }
  await DB.remove('alertas', { tipo: ['capacidad', 'minimo_ruta', 'flota'] });
  const ocupados = new Set(S.rutas.filter(r => r.estado !== 'simulada').map(r => r.vehiculo_id));
  const libres = S.vehiculos.filter(v => v.activo !== false && !ocupados.has(v.id)).sort((a, b) => +b.cap_cajas - +a.cap_cajas);
  const porZona = {}; elegibles.forEach(p => { const z = cli(p.cliente_id).zona_codigo; (porZona[z] = porZona[z] || []).push(p); });
  const zonas = Object.keys(porZona).sort((a, b) => totalesDe(porZona[b]).cajas - totalesDe(porZona[a]).cajas);
  const nuevas = [], pedUpd = []; let n = S.rutas.filter(r => r.estado !== 'simulada').length + 1;
  for (const z of zonas) {
    let rest = porZona[z].slice().sort(ordenPedidos);
    while (rest.length) {
      const dem = totalesDe(rest);
      // el vehículo más pequeño que se lleva toda la zona; si ninguno, el más grande libre
      const cand = libres.filter(v => dem.cajas <= +v.cap_cajas && dem.peso_kg <= +v.cap_peso_kg && dem.volumen_m3 <= +v.cap_volumen_m3).sort((a, b) => +a.cap_cajas - +b.cap_cajas)[0] || libres[0];
      if (!cand) { for (const p of rest) { p.estado = 'diferido'; p.causa = 'Sin vehículo libre: flota completa hoy · anexar a una ruta con espacio o diferir'; pedUpd.push(p); } await DB.alerta('flota', 'alta', `Zona ${zona(z).nombre}: ${rest.length} pedidos sin vehículo`, `Toda la flota activa está asignada. Anexa los pedidos a una ruta con espacio (B8) o difiérelos.`, 'ruta', ACTOR); break; }
      libres.splice(libres.indexOf(cand), 1);
      const r = { id: DB.uuid(), codigo: `R-${String(n++).padStart(2, '0')}`, fecha: hoy(), vehiculo_id: cand.id, conductor: cand.conductor, ayudante: cand.ayudante, zona_codigo: z, bodega_codigo: (S.bodega || {}).codigo || 'VA', estado: 'simulada', version: 1, cambios: 0, valor: 0, peso_kg: 0, volumen_m3: 0, cajas: 0, posiciones: 0, limite: null, hora_salida: R('hora_salida').valor || '07:00', color: cand.color, color_nombre: cand.color_nombre || '', minimo: minimoDe(cand) };
      r._ped = []; const quedan = [];
      for (const p of rest) { const ok = cabe(r, cand, p); const f = Object.keys(ok).find(k => !ok[k]); if (f) { r.limite = r.limite || `capacidad física (${QN[f]})`; quedan.push(p); continue; } r._ped.push(p); Object.assign(r, { valor: r.valor + +p.valor, peso_kg: r.peso_kg + +p.peso_kg, volumen_m3: r.volumen_m3 + +p.volumen_m3, cajas: r.cajas + +p.cajas }); p.estado = 'planificado'; p.ruta_id = r.id; p.causa = null; pedUpd.push(p); }
      if (!r._ped.length) { const p = quedan.shift(); p.estado = 'diferido'; p.causa = `Excede la capacidad de cualquier vehículo libre (${p.cajas} cajas, ${f1(p.peso_kg)} kg)`; pedUpd.push(p); libres.unshift(cand); n--; rest = quedan; continue; }
      if (quedan.length) await DB.audit('rutas', 'regla_capacidad_fisica', `${r.codigo} (${cand.placa}) llena por ${r.limite}: ${quedan.length} pedidos pasan a otra ruta de la zona`, 'motor de reglas', true, r.id);
      r.bajo_minimo = r.valor < r.minimo; nuevas.push(r); rest = quedan;
    }
  }
  for (const r of nuevas) await secuenciar(r);
  for (const r of nuevas) { const paradas = r._stops; const { _ped, _stops, ...row } = r; await DB.insert('rutas', [row]); await DB.insert('paradas', paradas.map(s => Object.assign({ ruta_id: r.id }, s))); }
  await Promise.all(pedUpd.map(p => DB.update('pedidos', { id: p.id }, { estado: p.estado, causa: p.causa, ruta_id: p.ruta_id || null })));
  for (const r of nuevas.filter(x => x.bajo_minimo)) { const v = veh(r.vehiculo_id); const sug = sugerenciaAnexo(r, nuevas); await DB.alerta('minimo_ruta', 'media', `${r.codigo} · ${v.placa}: venta B/. ${fmt(r.valor)} bajo el mínimo de B/. ${fmt(r.minimo)} (${tipoVeh(v.tipo)})`, `Falta B/. ${fmt(r.minimo - r.valor)}. ${sug ? 'Sugerencia: anexar a ' + sug + '. ' : ''}Al publicar se notifica a los dueños de las cuentas de la ruta y al gerente comercial (K6).`, 'ruta', 'Gerente comercial'); }
  await DB.audit('rutas', 'propuesta', `Propuesta del motor: ${nuevas.length} rutas, ${nuevas.reduce((s, r) => s + r._ped.length, 0)} entregas · límite por espacio y peso · ${nuevas.filter(r => r.bajo_minimo).length} bajo el mínimo de venta`, 'motor de rutas', true);
  $('plan-msg').innerHTML = ''; toast(`Propuesta: ${nuevas.length} rutas`); await loadAll(); render();
}
function sugerenciaAnexo(r, rutas) { const v = veh(r.vehiculo_id); const peds = (r._ped || S.pedidos.filter(p => p.ruta_id === r.id)); const t = totalesDe(peds); const op = (rutas || S.rutas).filter(o => o.id !== r.id && !['liberada', 'en_ruta', 'cerrada', 'conciliada'].includes(o.estado)).map(o => ({ o, w: veh(o.vehiculo_id) })).filter(({ o, w }) => w && +o.cajas + t.cajas <= +w.cap_cajas && +o.peso_kg + t.peso_kg <= +w.cap_peso_kg && +o.volumen_m3 + t.volumen_m3 <= +w.cap_volumen_m3); if (!op.length) return null; op.sort((a, b) => (a.o.zona_codigo === r.zona_codigo ? 0 : 1) - (b.o.zona_codigo === r.zona_codigo ? 0 : 1)); return `${op[0].o.codigo} (${op[0].w.placa}, tiene espacio)`; void v; }
async function secuenciar(r) {
  const B = S.bodega; let cur = { lat: +B.lat, lng: +B.lng }, t = tmin(r.hora_salida || '07:00'), rest = r._ped.slice(), stops = [], lunch = false; const vel = +R('velocidad_media_kmh').valor || 24, tol = +R('ventana_tolerancia').minutos || 15, alm = R('almuerzo');
  const pick = () => { rest.sort((a, b) => { const ca = cli(a.cliente_id), cb = cli(b.cliente_id); const lim = (c, p) => c.ventana_inicio && tmin(c.ventana_inicio) > t + 60 ? 1e5 : c.ventana_fin ? tmin(c.ventana_fin) : +p.prioridad === 1 ? 600 : 9999; // urgente sin ventana = antes de las 10:00, sin romper ventanas estrictas
    const wa = lim(ca, a), wb = lim(cb, b); if (Math.abs(wa - wb) > 90) return wa - wb; return GEO.km(cur, ca) - GEO.km(cur, cb); }); return rest.shift(); };
  while (rest.length) {
    const p = pick(); const c = cli(p.cliente_id); const d = GEO.kmVia(cur, c); t += d / vel * 60; let espera = 0;
    if (c.ventana_inicio && t < tmin(c.ventana_inicio)) { espera = tmin(c.ventana_inicio) - t; t = tmin(c.ventana_inicio); }
    const fuera = c.ventana_fin && t > tmin(c.ventana_fin) + tol;
    stops.push({ tipo: 'entrega', pedido_id: p.id, cliente_id: c.id, lat: +c.lat, lng: +c.lng, eta: hhmm(t), ventana_inicio: c.ventana_inicio, ventana_fin: c.ventana_fin, duracion_min: c.tiempo_servicio_min || 15, km_tramo: +d.toFixed(2), estado: 'pendiente', notas: (+p.prioridad === 1 ? 'URGENTE. ' : '') + (espera > 1 ? `Espera ${Math.round(espera)} min por ventana. ` : '') + (fuera ? 'FUERA DE VENTANA' : '') });
    t += c.tiempo_servicio_min || 15; cur = c;
    if (!lunch && alm && t >= tmin(alm.desde || '12:00')) { stops.push({ tipo: 'almuerzo', lat: +c.lat, lng: +c.lng, eta: hhmm(t), duracion_min: +alm.duracion_min || 45, km_tramo: 0, estado: 'pendiente', notas: 'Almuerzo del equipo según disponibilidad de la ruta' }); t += +alm.duracion_min || 45; lunch = true; }
  }
  const back = GEO.kmVia(cur, B); t += back / vel * 60;
  let kmt = stops.reduce((s, x) => s + x.km_tramo, 0) + back;
  const pts = [{ lat: +B.lat, lng: +B.lng }, ...stops.map(s => ({ lat: s.lat, lng: s.lng })), { lat: +B.lat, lng: +B.lng }];
  const rt = stops.length ? await GEO.route(pts) : null;
  if (rt) { r.geometria = rt.coords.filter((_, i) => i % 2 === 0); kmt = rt.km; let tt = tmin(r.hora_salida || '07:00'); stops.forEach((s, i) => { tt += rt.legs[i].min * 1.15; if (s.ventana_inicio && tt < tmin(s.ventana_inicio)) tt = tmin(s.ventana_inicio); s.eta = hhmm(tt); s.km_tramo = +rt.legs[i].km.toFixed(2); tt += s.duracion_min; }); t = tt + rt.legs[rt.legs.length - 1].min * 1.15; }
  else r.geometria = null;
  r._stops = stops.map((s, i) => Object.assign({ secuencia: i + 1 }, s)); r.km_plan = +kmt.toFixed(1); r.hora_fin_prevista = hhmm(t);
}
/* B8: una ruta planificada cambia hasta 7 veces al día (urgencias, anexo de clientes). Mover/anexar re-secuencia, versiona y avisa. */
const editable = r => r && !['liberada', 'en_ruta', 'cerrada', 'conciliada'].includes(r.estado);
async function rehacerRuta(r, motivo) {
  const peds = S.pedidos.filter(p => p.ruta_id === r.id);
  if (!peds.length) { await DB.remove('paquetes', { ruta_id: r.id }); const man = S.manifiestos.find(m => m.ruta_id === r.id); if (man) { await DB.remove('manifiesto_lineas', { manifiesto_id: man.id }); await DB.remove('manifiestos', { id: man.id }); } await DB.remove('paradas', { ruta_id: r.id }); await DB.remove('rutas', { id: r.id }); await DB.audit('rutas', 'ruta_eliminada', `${r.codigo} quedó sin pedidos y se eliminó · ${motivo}`, ACTOR, false, r.id); return; }
  const v = veh(r.vehiculo_id); const t = totalesDe(peds); Object.assign(r, t); r._ped = peds; r.minimo = minimoDe(v); r.bajo_minimo = r.valor < r.minimo;
  const ok = Object.entries({ vol: t.volumen_m3 <= +v.cap_volumen_m3 + 1e-9, peso: t.peso_kg <= +v.cap_peso_kg + 1e-9, cajas: t.cajas <= +v.cap_cajas }).filter(([, x]) => !x).map(([k]) => QN[k]); r.limite = ok.length ? `excede ${ok.join(', ')}` : null;
  await secuenciar(r); await DB.remove('paradas', { ruta_id: r.id }); await DB.insert('paradas', r._stops.map(s => Object.assign({ ruta_id: r.id }, s)));
  const pub = r.estado !== 'simulada'; if (pub) { r.version = (+r.version || 1) + 1; r.cambios = (+r.cambios || 0) + 1; }
  const { _ped, _stops, ...row } = r; await DB.update('rutas', { id: r.id }, row);
  if (pub) await generarDocsRuta(r, true);
}
async function moverPedido(pedId, destId, motivo = 'reorganización') {
  if (!exige('planificar')) return;
  const p = S.pedidos.find(x => x.id === pedId); const dest = S.rutas.find(r => r.id === destId); const orig = S.rutas.find(r => r.id === p.ruta_id);
  if (!dest || !editable(dest)) { toast('La ruta destino ya salió o no existe'); return; }
  if (orig && !editable(orig)) { toast('La ruta origen ya fue liberada'); return; }
  const w = veh(dest.vehiculo_id); const ok = cabe({ volumen_m3: dest.volumen_m3, peso_kg: dest.peso_kg, cajas: dest.cajas }, w, p); const f = Object.keys(ok).find(k => !ok[k]);
  if (f) { toast(`No cabe en ${dest.codigo}: supera ${QN[f]} de ${w.placa}`); return; }
  await DB.update('pedidos', { id: p.id }, { ruta_id: dest.id, estado: 'planificado', causa: `Anexado a ${dest.codigo} (${motivo})` }); p.ruta_id = dest.id; p.estado = 'planificado';
  if (orig) await rehacerRuta(orig, motivo); await rehacerRuta(dest, motivo);
  const max = +R('cambios_ruta').maximo_dia || 7;
  for (const r of [orig, dest].filter(Boolean)) {
    if (r.estado !== 'simulada' && S.rutas.some(x => x.id === r.id)) {
      await DB.notificar('telegram', r.conductor, 'conductor', `${r.codigo} cambió (v${r.version})`, `${r.codigo} v${r.version}: ${p.numero_factura} (${cli(p.cliente_id).nombre}) ${orig && r.id === orig.id ? `sale de tu ruta: retirar su mercancía del área ${orig.color_nombre} y pasarla al área ${dest.color_nombre}` : `entra a tu ruta: reimprimir su paquete con color ${dest.color_nombre}`}.`, 'cambio de ruta (B8)', r.id);
      if (+r.cambios >= max) await DB.alerta('cambios', 'media', `${r.codigo}: ${r.cambios} cambios hoy`, `Supera los ${max} cambios esperados por día (B8). Revisar planificación.`, 'ruta', 'Gerente de operaciones');
    }
  }
  await DB.audit('pedidos', 'reasignacion', `${p.numero_so} ${orig ? orig.codigo + ' → ' : 'anexado a '}${dest.codigo} · motivo: ${motivo}`, ACTOR, false, p.id);
  toast(`${p.numero_factura} → ${dest.codigo}`); await loadAll(); render();
}
async function anexarRuta(origId, destId) {
  const orig = S.rutas.find(r => r.id === origId), dest = S.rutas.find(r => r.id === destId); if (!orig || !dest) return; const peds = S.pedidos.filter(p => p.ruta_id === orig.id); const w = veh(dest.vehiculo_id); const t = totalesDe(peds);
  if (+dest.cajas + t.cajas > +w.cap_cajas || +dest.peso_kg + t.peso_kg > +w.cap_peso_kg || +dest.volumen_m3 + t.volumen_m3 > +w.cap_volumen_m3 + 1e-9) { toast(`${orig.codigo} no cabe completa en ${dest.codigo}`); return; }
  for (const p of peds) await DB.update('pedidos', { id: p.id }, { ruta_id: dest.id, causa: `Anexado desde ${orig.codigo} (ruta bajo mínimo)` });
  await loadAll(); const o2 = S.rutas.find(r => r.id === origId), d2 = S.rutas.find(r => r.id === destId); await rehacerRuta(o2, 'anexo de ruta bajo mínimo'); await rehacerRuta(d2, 'anexo de ruta bajo mínimo');
  await DB.remove('alertas', { tipo: 'minimo_ruta' }); await DB.audit('rutas', 'anexo', `${orig.codigo} (${peds.length} pedidos, B/. ${fmt(t.valor)}) anexada a ${dest.codigo}`, ACTOR, false, dest.id);
  toast(`${orig.codigo} anexada a ${dest.codigo}`); await loadAll(); render();
}
async function diferir(pedId) { const p = S.pedidos.find(x => x.id === pedId); const r = S.rutas.find(x => x.id === p.ruta_id); await DB.update('pedidos', { id: p.id }, { estado: 'diferido', ruta_id: null, causa: 'Diferido a mañana' }); if (r) { await loadAll(); await rehacerRuta(S.rutas.find(x => x.id === r.id), 'pedido diferido'); } await DB.audit('pedidos', 'diferido', `${p.numero_so} diferido`, ACTOR, false, p.id); await loadAll(); render(); }
/* Manifiesto y paquetes (uno por factura, con el color de la ruta). Al cambiar la ruta se regeneran y los paquetes vuelven a "pendiente" para reimpresión. */
async function generarDocsRuta(r, reimprimir = false) {
  const ped = S.pedidos.filter(p => p.ruta_id === r.id); const m = {}; ped.forEach(p => S.lineas.filter(l => l.pedido_id === p.id).forEach(l => { m[l.sku] = m[l.sku] || { sku: l.sku, requerido: 0 }; m[l.sku].requerido += +l.cantidad_cajas; }));
  let man = S.manifiestos.find(x => x.ruta_id === r.id);
  if (!man) { man = { id: DB.uuid(), ruta_id: r.id, numero: `MF-${r.codigo.slice(2)}-${hoy().replace(/-/g, '').slice(4)}`, estado: 'pendiente', preparador: 'Marta Rojas', cargador: 'Diego Castillo', verificador: (S.personas.find(p => p.rol === 'verificador') || {}).nombre }; await DB.insert('manifiestos', [man]); }
  else { await DB.remove('manifiesto_lineas', { manifiesto_id: man.id }); await DB.update('manifiestos', { id: man.id }, { estado: 'pendiente' }); }
  await DB.insert('manifiesto_lineas', Object.values(m).map(x => ({ manifiesto_id: man.id, sku: x.sku, ubicacion: (S.articulos.find(a => a.sku === x.sku) || {}).ubicacion, requerido: x.requerido, cargado: 0 })));
  const exist = await DB.all('paquetes', { ruta_id: r.id }); const ids = new Set(ped.map(p => p.id));
  for (const q of exist.filter(q => !ids.has(q.pedido_id))) await DB.remove('paquetes', { id: q.id });
  const stops = S.paradas.filter(s => s.ruta_id === r.id); const seqDe = pid => (stops.find(s => s.pedido_id === pid) || {}).secuencia || 0;
  const nuevos = [];
  for (const p of ped) {
    const q = exist.find(x => x.pedido_id === p.id) || (await DB.all('paquetes', { pedido_id: p.id }))[0];
    const base = { ruta_id: r.id, color: r.color, color_nombre: r.color_nombre };
    if (q) { if (q.ruta_id !== r.id || reimprimir && q.color !== r.color) await DB.update('paquetes', { id: q.id }, Object.assign(base, { estado: 'pendiente', impreso_at: null, en_area_at: null, lineas: null, verificado_at: null, firma_conductor: null, firma_verificador: null, firmado_at: null, books_shipment_id: null, books_registrado_at: null, nota: `Reasignado a ${r.codigo}: reimprimir` })); }
    else nuevos.push(Object.assign(base, { pedido_id: p.id, numero: `PQ-${r.codigo.slice(2)}-${p.numero_factura.replace(/\D/g, '')}`, estado: 'pendiente', diferencias: 0, faltante_cajas: 0 }));
  }
  if (nuevos.length) await DB.insert('paquetes', nuevos);
  void seqDe;
}
async function aprobar() {
  if (!exige('planificar')) return;
  const sim = S.rutas.filter(r => r.estado === 'simulada'); if (!sim.length) return;
  for (const r of sim) { await DB.update('rutas', { id: r.id }, { estado: 'publicada' }); r.estado = 'publicada'; await generarDocsRuta(r); }
  await DB.remove('alertas', { tipo: 'minimo_ruta' });
  for (const r of sim.filter(x => x.bajo_minimo)) await avisarBajoMinimo(r);
  await DB.audit('rutas', 'publicacion', `${sim.length} rutas aprobadas y publicadas · manifiestos y ${S.pedidos.filter(p => sim.some(r => r.id === p.ruta_id)).length} paquetes (uno por factura) generados`, ACTOR, false);
  toast('Rutas publicadas · paquetes listos para imprimir'); await loadAll(); render(); nav('picking');
}
/* K6: ruta bajo el mínimo → aviso segmentado a los dueños de las cuentas de la ruta + gerente comercial (G4). */
async function avisarBajoMinimo(r) {
  const v = veh(r.vehiculo_id); const peds = S.pedidos.filter(p => p.ruta_id === r.id); const porEj = {};
  peds.forEach(p => { const c = cli(p.cliente_id); (porEj[c.ejecutivo] = porEj[c.ejecutivo] || []).push(`${c.nombre} (${p.numero_factura}, B/. ${fmt(p.valor)})`); });
  const falta = +r.minimo - +r.valor;
  for (const [ej, cs] of Object.entries(porEj)) await DB.notificar('telegram', ej, 'ejecutivo', `${r.codigo} bajo el mínimo`, `La ruta ${r.codigo} (${v.placa}, ${tipoVeh(v.tipo)}) lleva B/. ${fmt(r.valor)} y el mínimo es B/. ${fmt(r.minimo)}: faltan B/. ${fmt(falta)}. Tus clientes en esta ruta: ${cs.join('; ')}. ¿Puedes sumar pedidos de la zona ${zona(r.zona_codigo).nombre}?`, 'ruta bajo mínimo (K6)', r.id);
  const gc = (S.personas.find(p => p.rol === 'gerente_comercial') || {}).nombre || 'Gerente comercial';
  await DB.notificar('telegram', gc, 'gerente_comercial', `${r.codigo} bajo el mínimo`, `${r.codigo} · ${v.placa}: B/. ${fmt(r.valor)} de B/. ${fmt(r.minimo)} (faltan ${fmt(falta)}). Ejecutivos notificados: ${Object.keys(porEj).join(', ')}.`, 'ruta bajo mínimo (K6)', r.id);
  await DB.alerta('minimo_ruta', 'media', `${r.codigo} publicada bajo el mínimo (B/. ${fmt(r.valor)} / ${fmt(r.minimo)})`, `Avisados: ${Object.keys(porEj).join(', ')} y ${gc}.`, 'ruta', gc);
}

// ===================== CARGUE =====================
async function scan(code, rutaId) {
  if (!exige('manifiesto.cargar')) return;
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
/* Una ruta sale solo cuando TODOS sus paquetes están verificados, firmados por conductor y verificador y registrados en Books (pasos 5-7). */
const PQ_LISTO = ['registrado', 'en_bodega', 'entregado_gd'];
function listaParaSalir(rid) { const q = S.paquetes.filter(x => x.ruta_id === rid); return q.length > 0 && q.every(x => PQ_LISTO.includes(x.estado)); }
async function liberar(id) {
  if (!(puede('manifiesto.cargar') || puede('verificar'))) return exige('verificar');
  id = id || $('m-ruta').value; const r = S.rutas.find(x => x.id === id); if (!r) return;
  if (!listaParaSalir(r.id)) { const q = S.paquetes.filter(x => x.ruta_id === r.id); toast(`${r.codigo} no puede salir: ${q.filter(x => !PQ_LISTO.includes(x.estado)).length} de ${q.length} paquetes sin verificar, firmar o registrar en Books`); return; }
  await DB.update('rutas', { id: r.id }, { estado: 'liberada' });
  await DB.notificar('telegram', r.conductor, 'conductor', `${r.codigo} liberada`, `${r.codigo} verificada y registrada. Puedes salir. ${S.paradas.filter(p => p.ruta_id === r.id && p.tipo === 'entrega').length} entregas, regreso previsto ${r.hora_fin_prevista || '—'}.`, 'ruta liberada', r.id);
  await DB.audit('rutas', 'liberada', `${r.codigo} liberada al conductor ${r.conductor}: paquetes verificados, firmados y registrados en Books`, ACTOR, false, r.id);
  toast(`${r.codigo} liberada a ${r.conductor}`); await loadAll(); render();
}

// ===================== COSTOS =====================
async function cerrar() {
  if (!exige('costos')) return;
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
  if (!exige('catalogo.editar') || !exige('ia.usar')) return;
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
  if (!exige('catalogo.editar')) return;
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
  if (!exige('ia.usar')) return;
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
  if (!exige('pedidos.validar')) return;
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
function nav(v) { if (!puede('ver.' + v)) { toast('Tu rol no tiene acceso a esta vista'); return; } S.view = v; document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v)); document.querySelectorAll('.view').forEach(s => s.classList.toggle('on', s.id === 'v-' + v));
  $('vtitle').textContent = { torre: 'Torre de control diaria', pedidos: 'Pedidos y elegibilidad', plan: 'Planificación y optimización', manif: 'Manifiesto maestro y cargue', seguimiento: 'Seguimiento en vivo', picking: 'Picking masivo por ruta y paquetes', verif: 'Verificación de salida', gd: 'Gestión documental', incent: 'Programa de incentivos', avisos: 'Avisos y notificaciones', costos: 'Costos, combustible y flota', reglas: 'Reglas de negocio y auditoría', catalogo: 'Catálogo de datos maestros', config: PROD ? 'App móvil y sistema' : 'Conexión y app móvil', usuarios: 'Usuarios y permisos', integraciones: 'Integraciones · WhatsApp y Zoho' }[v];
  if (v === 'usuarios' && window.USR) USR.render(); if (v === 'integraciones' && window.INTEG) INTEG.render(); window.scrollTo({ top: 0 }); if (v === 'torre' && map) setTimeout(() => map.invalidateSize(), 50); }
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
  if (S.bodega) { $('ctx-bodega').textContent = S.bodega.nombre; $('ctx-corte').textContent = S.bodega.hora_corte || '15:00'; }
  const fecha = new Date().toLocaleDateString('es-PA', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' }); $('ctx-fecha').textContent = fecha; $('foot-fecha').textContent = fecha;
  // KPIs torre
  const enRuta = S.rutas.filter(r => ['liberada', 'en_ruta'].includes(r.estado)).length, ent = S.paradas.filter(p => p.tipo === 'entrega'), atend = ent.filter(p => ['atendida', 'parcial', 'no_entregada'].includes(p.estado)).length;
  const ico = { box: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/></svg>', ok: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12l5 5L20 7"/></svg>', warn: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4m0 4h.01M10.3 3.9L2.5 17.5A2 2 0 004.2 21h15.6a2 2 0 001.7-3.5L13.7 3.9a2 2 0 00-3.4 0z"/></svg>', truck: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="6" width="14" height="10" rx="2"/><path d="M15 9h4l3 3v4h-7z"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></svg>' };
  $('kpis').innerHTML = [['Pedidos del día', P.length, `B/. ${fmt(P.reduce((s, p) => s + +p.valor, 0))} · ${new Set(P.map(p => p.cliente_id)).size} clientes`, ico.box, ''], ['Elegibles / planificados', el.length, `${P.filter(p => p.estado === 'planificado').length} asignados a ruta`, ico.ok, ''], ['En excepción', ex.length, ex.length ? 'Requieren acción de ejecutivo o CxC' : 'Sin excepciones', ico.warn, ex.length ? 'crit' : ''], ['Rutas', S.rutas.length, S.rutas.length ? `${enRuta} en ejecución · ${atend}/${ent.length} entregas atendidas · ${f1(S.rutas.reduce((s, r) => s + (+r.km_plan || 0), 0))} km` : 'Sin planificar', ico.truck, 'info']].map(k => `<div class="card tile ${k[4]}"><div class="ico">${k[3]}</div><div class="l">${k[0]}</div><div class="v">${k[1]}</div><div class="s">${k[2]}</div></div>`).join('');
  $('tb-rutas').innerHTML = S.rutas.length ? S.rutas.map(r => { const v = veh(r.vehiculo_id) || {}; const ps = S.paradas.filter(p => p.ruta_id === r.id && p.tipo === 'entrega'); return `<tr><td class="code"><span class="swatch" style="background:${r.color || v.color}"></span><b>${r.codigo}</b> <span class="mini">${esc(r.color_nombre || '')}</span><br><span class="mini">${zona(r.zona_codigo).nombre}</span></td><td>${v.placa} <span class="mini">${v.nombre}</span><br><span class="mini">${r.conductor}${r.ayudante ? ' + ' + r.ayudante : ''}</span></td><td>${rpill(r.estado)}${r.version > 1 ? ` <span class="pill p-info nodot">v${r.version}</span>` : ''}</td><td class="num">${ps.filter(p => ['atendida', 'parcial', 'no_entregada'].includes(p.estado)).length}/${ps.length}</td><td class="num">${fmt(r.valor)}${r.valor < (+r.minimo || 0) ? '<br><span class="pill p-warn nodot">bajo mínimo</span>' : ''}</td><td class="num">${f1(r.km_plan)}</td><td class="num">${r.hora_fin_prevista || '—'}</td></tr>`; }).join('') : `<tr><td colspan="7" class="note">Valida los pedidos y genera la propuesta en Planificación.</td></tr>`;
  $('rutas-note').textContent = S.rutas.length ? `${S.rutas.length} rutas · ${ent.length} entregas` : 'Sin rutas generadas todavía';
  const al = S.alertas.filter(a => !a.cerrada); $('alertas').innerHTML = al.length ? al.slice(0, 10).map(a => `<div class="alert ${a.severidad === 'alta' ? 'crit' : a.severidad === 'media' ? 'warn' : 'info'}"><span class="dot"></span><div><b>${esc(a.titulo)}</b><small>${esc(a.detalle)}${a.destinatario ? ' · → ' + esc(a.destinatario) : ''}</small></div></div>`).join('') : `<div class="empty">Sin alertas. Al validar pedidos aparecerán aquí las excepciones con causa y responsable.</div>`;
  $('al-note').textContent = al.length ? `${al.length} activas · escalamiento a las ${R('escalamiento_excepcion').horas || 2} h` : '';
  drawMap();
  // pedidos
  $('ped-kpis').innerHTML = [['Importados', P.length, 'Zoho Inventory · Books'], ['Elegibles', el.length, 'listos para planificar'], ['Complementarios agrupados', P.filter(p => p.grupo).length, 'facturas < mínimo sumadas por cliente'], ['Excepciones', ex.length, 'con causa y responsable']].map(k => `<div class="tile"><div class="l">${k[0]}</div><div class="v">${k[1]}</div><div class="s">${k[2]}</div></div>`).join('');
  let rows = P.slice().sort((a, b) => (+a.prioridad || 3) - (+b.prioridad || 3)); if (S.pedTab === 'elegible') rows = P.filter(p => ['elegible', 'planificado'].includes(p.estado)); if (S.pedTab === 'en_excepcion') rows = ex; if (S.pedTab === 'agrupados') rows = P.filter(p => p.grupo); if (S.pedTab === 'diferido') rows = P.filter(p => p.estado === 'diferido');
  $('tb-ped').innerHTML = rows.map(p => { const c = cli(p.cliente_id) || {}; const z = zona(c.zona_codigo); const r = S.rutas.find(x => x.id === p.ruta_id); return `<tr><td class="code">${p.numero_so}${+p.prioridad === 1 ? ' <span class="pill p-crit nodot">urgente</span>' : ''}<br><span class="mini">${esc(p.numero_factura || 'sin factura')}</span></td><td><b>${esc(c.nombre)}</b>${p.grupo ? ' <span class="pill p-info nodot">grupo</span>' : ''}<br><span class="mini">${esc((c.direccion || '').slice(0, 60))}</span></td><td><span class="pill nodot" style="background:${z.color}1f;color:${z.color}">${z.nombre.split(' ·')[0]}</span></td><td>${esc(c.ejecutivo)}</td><td class="code">${c.ventana_inicio ? c.ventana_inicio + '–' + c.ventana_fin : '—'}</td><td class="num">${fmt(p.valor)}</td><td class="num">${f1(p.peso_kg)}</td><td class="num">${(+p.volumen_m3).toFixed(2)}</td><td class="num">${p.cajas}</td><td>${pill(p.estado)}${r ? ` <span class="code" style="color:${r.color}">${r.codigo}</span>` : ''}</td><td class="note">${esc(p.causa || '')}${c.credito_bloqueado && p.estado === 'en_excepcion' ? ` <div class="row" style="margin-top:4px"><button class="btn xs" data-pp="${p.id}">Registrar promesa de pago</button></div>` : ''}${['elegible', 'diferido'].includes(p.estado) && !p.ruta_id && S.rutas.some(editable) ? ` <div class="row" style="margin-top:4px"><select class="xs" data-anexar="${p.id}"><option value="">Anexar a ruta…</option>${S.rutas.filter(editable).map(x => `<option value="${x.id}">${x.codigo} · ${esc(x.color_nombre || '')} · ${(veh(x.vehiculo_id) || {}).placa}</option>`).join('')}</select></div>` : ''}${p.estado === 'en_excepcion' ? ` <div class="row" style="margin-top:4px"><button class="btn ${IA.tri[p.id] ? 'info' : 'sec'} xs" data-tri="${p.id}">${IA.tri[p.id] ? (IA.tri[p.id].estado === 'propuesta' ? 'Ver propuesta IA: ' + esc(ACC[IA.tri[p.id].accion_recomendada] || '') : 'Triage ' + IA.tri[p.id].estado) : 'Triage IA'}</button></div>` : ''}</td></tr>`; }).join('') || `<tr><td colspan="11" class="note">Nada en esta vista.</td></tr>`;
  // plan
  $('b-aprobar').disabled = !S.rutas.some(r => r.estado === 'simulada');
  const libresN = S.vehiculos.filter(v => v.activo !== false && !S.rutas.some(r => r.vehiculo_id === v.id)).length;
  $('plan-flota').textContent = `Flota activa ${S.vehiculos.filter(v => v.activo !== false).length} · libres ${libresN} · mínimo de venta: panel B/. ${fmt(R('minimo_ruta').panel || 2500)}, camión B/. ${fmt(R('minimo_ruta').camion || 5000)}`;
  $('plan-veh').innerHTML = S.rutas.length ? S.rutas.map(r => { const v = veh(r.vehiculo_id) || {}; const ped = S.pedidos.filter(p => p.ruta_id === r.id); const min = +r.minimo || minimoDe(v);
    const b = (l, x, m, u) => { const pc = Math.min(100, x / m * 100); return `<div><div class="cap"><span>${l}</span><span class="code">${x % 1 ? f1(x) : x} / ${m} ${u}</span></div><div class="bar ${pc >= 100 ? 'c' : pc >= 85 ? 'w' : ''}"><i style="width:${pc}%"></i></div></div>`; };
    const vm = Math.min(100, r.valor / min * 100); const otras = S.rutas.filter(o => o.id !== r.id && editable(o));
    return `<div class="card veh" style="--vc:${r.color || v.color}"><div class="hd"><div><h3><span class="swatch" style="background:${r.color || v.color}"></span>${r.codigo} · ${esc(r.color_nombre || '')} · ${zona(r.zona_codigo).nombre}</h3><div class="mini">${v.placa} ${tipoVeh(v.tipo)} · ${esc(r.conductor)}${r.ayudante ? ' + ' + esc(r.ayudante) : ''}</div></div><div>${rpill(r.estado)}${r.version > 1 ? ` <span class="pill p-info nodot">v${r.version} · ${r.cambios || 0} cambios</span>` : ''}</div></div>
    <div class="stack" style="gap:7px"><div><div class="cap"><span>Venta vs mínimo de la ruta</span><span class="code">B/. ${fmt(r.valor)} / ${fmt(min)}</span></div><div class="bar ${r.valor >= min ? '' : 'w'}"><i style="width:${vm}%"></i></div></div>${b('Cajas', r.cajas, v.cap_cajas, '')}${b('Peso', Math.round(r.peso_kg), v.cap_peso_kg, 'kg')}${b('Volumen', +(+r.volumen_m3).toFixed(2), v.cap_volumen_m3, 'm³')}</div>
    <div class="row" style="margin-top:12px;justify-content:space-between"><span class="mini">${ped.length} facturas · ${f1(r.km_plan)} km · regreso ${r.hora_fin_prevista || '—'}</span>${r.valor < min ? `<span class="pill p-warn">Bajo mínimo · faltan B/. ${fmt(min - r.valor)}</span>` : '<span class="pill p-ok">Cumple mínimo</span>'}${r.limite ? `<span class="pill p-mut">Llena por ${esc(r.limite)}</span>` : ''}</div>
    ${r.valor < min && editable(r) && otras.length ? `<div class="row" style="margin-top:8px"><select class="xs" data-anexr="${r.id}"><option value="">Anexar ruta completa a…</option>${otras.map(o => `<option value="${o.id}">${o.codigo} · ${(veh(o.vehiculo_id) || {}).placa} · ${o.cajas}/${(veh(o.vehiculo_id) || {}).cap_cajas} cajas</option>`).join('')}</select><span class="mini">${esc(sugerenciaAnexo(r) ? 'Sugerida: ' + sugerenciaAnexo(r) : 'Ninguna ruta tiene espacio para toda la carga')}</span></div>` : ''}</div>`; }).join('') : `<div class="card empty" style="grid-column:1/-1">Primero valida los pedidos; luego genera la propuesta. El motor llena cada vehículo por espacio y peso y avisa cuando una ruta no alcanza la venta mínima.</div>`;
  $('plan-detail').innerHTML = S.rutas.length ? S.rutas.map(r => { const v = veh(r.vehiculo_id) || {}; const st = S.paradas.filter(p => p.ruta_id === r.id).sort((a, b) => a.secuencia - b.secuencia); const otras = S.rutas.filter(o => o.id !== r.id && editable(o)); return `<h3 style="margin:12px 0 8px;color:${r.color || v.color}"><span class="swatch" style="background:${r.color || v.color}"></span>${r.codigo} · ${esc(r.color_nombre || '')} · ${v.placa} · ${zona(r.zona_codigo).nombre}</h3><div class="tw"><table><thead><tr><th class="num">#</th><th>Parada</th><th>Tipo</th><th>Ventana</th><th class="num">ETA</th><th class="num">Km tramo</th><th class="num">Servicio</th><th>Estado</th><th>${editable(r) ? 'Cambio (B8)' : ''}</th></tr></thead><tbody>${st.map(s => { const c = s.cliente_id ? cli(s.cliente_id) : null; const p = s.pedido_id ? S.pedidos.find(x => x.id === s.pedido_id) : null; return `<tr><td class="num">${s.secuencia}</td><td>${c ? `<b>${esc(c.nombre)}</b> <span class="mini">${p ? p.numero_factura + ' · ' + p.cajas + ' cajas' : ''}</span>${p && +p.prioridad === 1 ? ' <span class="pill p-crit nodot">urgente</span>' : ''}` : esc(s.notas)}</td><td>${spill(s.tipo)}</td><td class="code">${s.ventana_inicio ? s.ventana_inicio + '–' + s.ventana_fin : '—'}</td><td class="num">${s.eta}${(s.notas || '').includes('FUERA') ? ' <span class="pill p-crit nodot">fuera</span>' : (s.notas || '').includes('Espera') ? ' <span class="pill p-info nodot">espera</span>' : ''}</td><td class="num">${f1(s.km_tramo)}</td><td class="num">${s.duracion_min}′</td><td>${stpill(s.estado)}</td><td>${p && editable(r) && otras.length ? `<select class="xs" data-mover="${p.id}"><option value="">Mover a…</option>${otras.map(o => `<option value="${o.id}">${o.codigo} · ${esc(o.color_nombre || '')}</option>`).join('')}<option value="__diferir">Diferir a mañana</option></select>` : ''}</td></tr>`; }).join('')}</tbody></table></div>`; }).join('') : `<div class="empty">Genera la propuesta para ver la secuencia de paradas.</div>`;
  document.querySelectorAll('[data-tri]').forEach(b => b.onclick = () => iaTriage(b.dataset.tri)); document.querySelectorAll('[data-dif]').forEach(b => b.onclick = () => diferir(b.dataset.dif)); document.querySelectorAll('[data-pp]').forEach(b => b.onclick = () => promesaPago(b.dataset.pp));
  document.querySelectorAll('[data-anexar]').forEach(x => x.onchange = () => x.value && moverPedido(x.dataset.anexar, x.value, 'anexo de pedido a ruta planificada'));
  document.querySelectorAll('[data-mover]').forEach(x => x.onchange = () => { if (!x.value) return; if (x.value === '__diferir') diferir(x.dataset.mover); else moverPedido(x.dataset.mover, x.value, 'urgencia / reorganización'); });
  document.querySelectorAll('[data-anexr]').forEach(x => x.onchange = () => x.value && anexarRuta(x.dataset.anexr, x.value));
  renderManif(); renderSeguimiento(); renderCostos(); renderReglas(); renderCatalogo(); renderConfig(); renderUsuario();
  renderPicking(); renderVerif(); renderGD(); renderIncentivos(); renderAvisos();
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
  $('b-liberar').disabled = !(listaParaSalir(r.id) && ['publicada', 'en_cargue'].includes(r.estado));
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
  document.querySelectorAll('[data-inc-close]').forEach(b => b.onclick = async () => { if (!exige('seguimiento.incidencias')) return; const i = S.incidencias.find(x => x.id === b.dataset.incClose); await DB.update('incidencias', { id: i.id }, { estado: 'cerrada', cerrada_at: new Date().toISOString() }); await DB.audit('incidencias', 'cierre', `${i.tipo}: ${i.descripcion || ''} · cerrada por torre de control`, ACTOR, false, i.id); toast('Incidencia cerrada'); await refreshLive(); });
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
  const sc = v => v === null || ['number', 'string', 'boolean'].includes(typeof v);
  $('tb-reglas').innerHTML = S.reglasRows.map(r => { const v = r.valor || {}; const ks = Object.keys(v); const simple = ks.every(k => sc(v[k])); return `<tr><td><b>${esc(r.descripcion || r.clave)}</b><br><span class="mini code">${r.clave} · ${esc(r.actualizado_por || '')}</span></td><td>${simple ? ks.map(k => `<label class="mini" style="display:block">${ks.length > 1 ? esc(k) + ' ' : ''}<input ${typeof v[k] === 'number' ? 'type="number"' : ''} data-r="${r.clave}" data-k="${k}" value="${esc(v[k])}" style="width:110px" ${puede('reglas') ? '' : 'disabled'}></label>`).join('') : '<span class="mini">Se edita en Incentivos → Metas</span>'}</td><td class="note">${esc(r.accion || '')}</td></tr>`; }).join('');
  $('reglas-perm').textContent = puede('reglas') ? `Puedes editar (${ROL_N[rolActual()]}).` : `Solo Administración, Facturación y Bodega modifican reglas (A5). Tu rol: ${ROL_N[rolActual()] || rolActual()}.`;
  document.querySelectorAll('[data-r]').forEach(i => i.onchange = async () => { if (!exige('reglas')) return; const row = S.reglasRows.find(r => r.clave === i.dataset.r); const old = row.valor[i.dataset.k]; const nv = typeof old === 'number' ? +i.value : i.value; const nuevo = Object.assign({}, row.valor, { [i.dataset.k]: nv }); await DB.update('reglas', { id: row.id }, { valor: nuevo, actualizado_por: ACTOR, updated_at: new Date().toISOString() }); await DB.audit('reglas', 'cambio', `${row.clave}.${i.dataset.k}: ${old} → ${nv} · vigente desde hoy`, ACTOR, false, row.id); toast('Regla actualizada y auditada'); await loadAll(); render(); });
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
  if (!exige('catalogo.editar')) return;
  const t = S.catTab; Papa.parse(file, { header: true, skipEmptyLines: true, dynamicTyping: true, complete: async res => {
    const rows = res.data; let n = 0;
    if (t === 'pedidos') { const byCod = {}; S.clientes.forEach(c => byCod[c.codigo] = c.id); const ped = rows.filter(r => byCod[r.cliente_codigo]).map(r => ({ numero_so: String(r.numero_so), numero_factura: r.numero_factura, cliente_id: byCod[r.cliente_codigo], fecha: r.fecha || hoy(), prioridad: r.prioridad || 3, valor: +r.valor, peso_kg: +r.peso_kg || 0, volumen_m3: +r.volumen_m3 || 0, cajas: +r.cajas || 0, estado: 'pendiente_validar' })); await DB.upsert('pedidos', ped, 'numero_so'); n = ped.length; }
    else { const clean = rows.map(r => { const o = {}; CAT[t].forEach(c => { if (r[c] !== undefined && r[c] !== '') o[c] = r[c]; }); if (t === 'clientes' && (o.lat == null)) o.geo_estado = 'pendiente'; return o; }).filter(o => o[KEY[t]]); await DB.upsert(t, clean, KEY[t]); n = clean.length; }
    await DB.audit(t, 'importacion_csv', `${n} registros importados desde ${file.name}`, ACTOR, false); toast(`${n} registros importados`); await loadAll(); render(); } });
}
async function geocodePendientes() {
  if (!exige('catalogo.editar')) return;
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
function renderUsuario() {
  if (Auth.activo) {
    const f = Auth.perfil; const box = $('user-box');
    if (box && !box.dataset.done) {
      box.innerHTML = `<div class="ub-av">${esc((f.nombre || f.email || '?').split(' ').map(x => x[0]).slice(0, 2).join(''))}</div><div class="ub-tx"><b>${esc(f.nombre || f.email)}</b><small>${esc(f.rol_nombre || ROL_N[f.rol] || f.rol)}</small></div><button class="ub-b" id="b-clave" title="Cambiar contraseña" aria-label="Cambiar contraseña"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg></button><button class="ub-b" id="b-salir" title="Cerrar sesión" aria-label="Cerrar sesión"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg></button>`;
      box.dataset.done = 1; box.hidden = false; $('b-salir').onclick = () => Auth.logout(); $('b-clave').onclick = () => Auth.cambiarClave();
      const lab = document.querySelector('label.user'); if (lab) lab.remove();
    }
    return;
  }
  const sel = $('user-sel'); if (!sel) return; const ofi = S.personas.filter(p => !['conductor', 'ayudante'].includes(p.rol));
  if (!ofi.some(p => p.nombre === ACTOR) && ofi[0]) ACTOR = ofi[0].nombre;
  sel.innerHTML = ofi.map(p => `<option value="${esc(p.nombre)}">${esc(p.nombre)} · ${ROL_N[p.rol] || p.rol}</option>`).join(''); sel.value = ACTOR;
}
/* Menú según permisos: oculta las vistas sin "ver.<vista>" y las acciones de demostración en producción. */
function aplicarPermisosUI() {
  document.querySelectorAll('.nav button[data-v]').forEach(b => { b.hidden = !puede('ver.' + b.dataset.v); });
  document.querySelectorAll('[data-perm]').forEach(e => { e.hidden = !e.dataset.perm.split('|').some(puede); });
  document.querySelectorAll('[data-demo]').forEach(e => { e.hidden = PROD; });
  if (!puede('ver.' + S.view)) { const first = document.querySelector('.nav button[data-v]:not([hidden])'); if (first) nav(first.dataset.v); }
  const ver = $('foot-ver'); if (ver) ver.textContent = (window.DGP_CONFIG && DGP_CONFIG.version) || '3.0';
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
if ($('user-sel')) $('user-sel').onchange = e => { ACTOR = e.target.value; try { localStorage.setItem('dgp_user', ACTOR); } catch (x) { } toast(`Usuario: ${ACTOR} (${ROL_N[rolActual()]})`); render(); };
$('b-validar').onclick = validar; $('b-plan').onclick = planificar; $('b-aprobar').onclick = aprobar; $('b-liberar').onclick = () => liberar(); $('m-ruta').onchange = renderManif; $('b-cerrar').onclick = cerrar;
$('b-scan').onclick = () => { const v = $('scan-in').value.trim(); if (v) scan(v, $('m-ruta').value); $('scan-in').value = ''; }; $('scan-in').onkeydown = e => { if (e.key === 'Enter') $('b-scan').click(); };
$('b-scan-sel').onclick = () => scan($('scan-sel').value, $('m-ruta').value);
$('b-scan-all').onclick = async () => { const man = S.manifiestos.find(m => m.ruta_id === $('m-ruta').value); if (!man) return; for (const l of S.mlineas.filter(x => x.manifiesto_id === man.id && x.cargado < x.requerido)) await scan(l.sku, $('m-ruta').value); await loadAll(); render(); };
$('b-print').onclick = () => window.print();
[['f-chofer', 'chofer'], ['f-ruta', 'ruta'], ['f-estado-ruta', 'estadoRuta'], ['f-estado', 'estado'], ['f-inc', 'inc']].forEach(([id, k]) => $(id).onchange = () => { SEG[k] = $(id).value; renderSeguimiento(); });
$('f-clear').onclick = () => { Object.keys(SEG).forEach(k => SEG[k] = ''); ['f-chofer', 'f-ruta', 'f-estado-ruta', 'f-estado', 'f-inc'].forEach(id => $(id).value = ''); renderSeguimiento(); };
$('b-geocode').onclick = geocodePendientes; $('csv-file').onchange = e => { if (e.target.files[0]) importCSV(e.target.files[0]); e.target.value = ''; };
$('b-export').onclick = () => download(`${S.catTab}_${hoy()}.csv`, Papa.unparse({ fields: CAT[S.catTab], data: (S.catTab === 'pedidos' ? S.pedidos.map(p => Object.assign({}, p, { cliente_codigo: (cli(p.cliente_id) || {}).codigo })) : S[S.catTab]).map(r => CAT[S.catTab].map(c => r[c])) }));
$('b-cfg').onclick = () => { DB.saveCfg({ url: $('cfg-url').value.trim(), key: $('cfg-key').value.trim() }); location.reload(); };
$('b-cfg-local').onclick = () => { DB.saveCfg({ url: '', key: '' }); location.reload(); }; // {} no anulaba la URL de config.js
$('b-ai-save').onclick = () => { AI.save({ endpoint: $('ai-endpoint').value.trim(), key: $('ai-key').value.trim(), model: $('ai-model').value.trim() }); $('ai-msg').textContent = 'Guardado · modo ' + AI.modo(); toast('Configuración de IA guardada'); };
$('b-ia-dir').onclick = iaDirecciones; $('b-ia-tri').onclick = iaTriageTodas;
$('b-reset').onclick = async () => { if (!exige('sistema.reset')) return; if (!confirm('¿Reiniciar la operación del día? Se borran rutas, manifiestos, eventos y costos.')) return; await DB.resetOperacion(); scanLog.length = 0; drawMap._fit = false; toast('Operación reiniciada'); await loadAll(); render(); nav('torre'); };
// ===================== INICIO =====================
window.addEventListener('DOMContentLoaded', async function () { // espera a salida.js e incentivos.js
  try { await Auth.init({ valida: f => f.permisos.some(x => x.startsWith('ver.')), textoSinAcceso: 'Tu rol solo usa la app del conductor. Ábrela desde el teléfono: …/conductor.html' }); } catch (e) { return; } // sin sesión: queda la pantalla de inicio de sesión
  if (Auth.activo) ACTOR = Auth.perfil.nombre || Auth.perfil.email;
  try { await DB.init(); } catch (e) { $('mode-txt').textContent = 'Sin conexión con la base'; document.querySelector('.main').innerHTML = `<div class="card" style="margin:40px auto;max-width:560px"><h2>No hay conexión con la base de datos</h2><p class="note">${esc(e.message || e)}</p><p class="note">En producción la torre no trabaja sin base de datos para no perder información. Reintenta en unos minutos.</p><button class="btn pri" onclick="location.reload()">Reintentar</button></div>`; return; }
  initMap(); await loadAll(); aplicarPermisosUI(); render();
  $('ctx-sync').textContent = DB.getMode() === 'supabase' ? 'Sincronizado con Supabase' : 'Modo local';
  setInterval(() => { if (['torre', 'seguimiento', 'verif', 'avisos'].includes(S.view) && !document.hidden) refreshLive().catch(console.warn); }, DB.getMode() === 'supabase' ? 10000 : 4000);
});
