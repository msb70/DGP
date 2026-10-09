/* DGP · Salida verificada (infografía "¡Cada pedido sale verificado!") + picking masivo por ruta + gestión documental + avisos.
   Pasos: 1 imprime por color de ruta · 2 paquete sobre la mercancía · 3 conductor organiza y lleva al área de cargue ·
   4 llama al verificador · 5 dicta y verifica cada artículo · 6 firman conductor y verificador · 7 verificador registra el envío en Books ·
   8 encargado de bodega entrega a Gestión Documental. */
const PQ_ORD = ['pendiente', 'impreso', 'en_area', 'verificado', 'firmado', 'registrado', 'en_bodega', 'entregado_gd'];
const zohoActivo = () => !!((S.integraciones || []).find(i => (i.sistema === 'zoho_books' || i.sistema === 'zoho_inventory') && i.activo));
const PQ_N = { pendiente: ['Por imprimir', 'p-mut'], impreso: ['Impreso', 'p-info'], en_area: ['En área de color', 'p-info'], verificado: ['Verificado', 'p-vio'], firmado: ['Firmado', 'p-vio'], registrado: ['Registrado en Books', 'p-ok'], en_bodega: ['Con encargado de bodega', 'p-ok'], entregado_gd: ['Entregado a Gestión Documental', 'p-ok'] };
const pqPill = e => { const x = PQ_N[e] || [e, 'p-mut']; return `<span class="pill ${x[1]}">${x[0]}</span>`; };
const pqMin = (rid, e) => { const q = S.paquetes.filter(x => x.ruta_id === rid); return q.length > 0 && q.every(x => PQ_ORD.indexOf(x.estado) >= PQ_ORD.indexOf(e)); };
const claro = hex => { const h = (hex || '#000').replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16); return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 > 160; };
const hora = t => t ? new Date(t).toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit' }) : '';
const rutaColor = r => r.color || (veh(r.vehiculo_id) || {}).color || '#64748B';
const rutaColorN = r => r.color_nombre || (veh(r.vehiculo_id) || {}).color_nombre || '';
const pedPq = q => S.pedidos.find(p => p.id === q.pedido_id) || {};
const seqDe = q => (S.paradas.find(s => s.pedido_id === q.pedido_id) || {}).secuencia || 0;

// ===================== IMPRESIÓN =====================
function imprimir(html) {
  const pa = $('print-area'); pa.innerHTML = html; document.body.classList.add('printing');
  const fin = () => { document.body.classList.remove('printing'); window.removeEventListener('afterprint', fin); };
  window.addEventListener('afterprint', fin); setTimeout(() => window.print(), 80);
}
function qrData(text) { try { const d = document.createElement('div'); new QRCode(d, { text, width: 96, height: 96, correctLevel: QRCode.CorrectLevel.M }); const c = d.querySelector('canvas'); return c ? c.toDataURL() : ''; } catch (e) { return ''; } }
function descargarCSV(nombre, filas) { const t = '﻿' + Papa.unparse(filas); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([t], { type: 'text/csv;charset=utf-8' })); a.download = nombre; a.click(); }

// ===================== PICKING MASIVO =====================
function rutasPk() { const todas = $('pk-filtro') && $('pk-filtro').value === 'todas'; return S.rutas.filter(r => todas || r.estado !== 'simulada').filter(r => !['cerrada', 'conciliada'].includes(r.estado)).sort((a, b) => a.codigo.localeCompare(b.codigo)); }
function matrizPicking(rutas) {
  const m = {}; const tot = {}; const fac = {};
  rutas.forEach(r => { tot[r.id] = 0; const ps = S.pedidos.filter(p => p.ruta_id === r.id); fac[r.id] = ps.length; ps.forEach(p => S.lineas.filter(l => l.pedido_id === p.id).forEach(l => { m[l.sku] = m[l.sku] || {}; m[l.sku][r.id] = (m[l.sku][r.id] || 0) + +l.cantidad_cajas; tot[r.id] += +l.cantidad_cajas; })); });
  const filas = Object.keys(m).map(sku => { const a = S.articulos.find(x => x.sku === sku) || {}; const t = rutas.reduce((s, r) => s + (m[sku][r.id] || 0), 0); return { sku, a, por: m[sku], total: t }; }).sort((x, y) => (x.a.ubicacion || 'ZZ').localeCompare(y.a.ubicacion || 'ZZ') || x.sku.localeCompare(y.sku));
  return { filas, tot, fac, gran: Object.values(tot).reduce((s, x) => s + x, 0) };
}
function renderPicking() {
  const rutas = rutasPk(); const M = matrizPicking(rutas);
  if (!rutas.length) { $('pk-tiles').innerHTML = '<div class="empty" style="grid-column:1/-1">Publica las rutas en Planificación (o elige "Incluir propuesta sin publicar") para ver el picking masivo.</div>'; $('pk-tabla').innerHTML = ''; $('pk-rutas').innerHTML = ''; $('pk-note').textContent = ''; return; }
  const nPq = S.paquetes.filter(q => rutas.some(r => r.id === q.ruta_id));
  $('pk-tiles').innerHTML = [['Rutas', rutas.length, rutas.map(r => r.codigo).join(' · ')], ['Total cajas a sacar', M.gran.toLocaleString('es-PA'), `${M.filas.length} artículos distintos`], ['Facturas / paquetes', Object.values(M.fac).reduce((s, x) => s + x, 0), `${nPq.filter(q => q.impreso_at).length} paquetes impresos`], ['En área de color', `${nPq.filter(q => PQ_ORD.indexOf(q.estado) >= 2).length} / ${nPq.length}`, 'paquete sobre su mercancía']].map(k => `<div class="tile"><div class="l">${k[0]}</div><div class="v" style="font-size:24px">${k[1]}</div><div class="s">${esc(k[2])}</div></div>`).join('');
  $('pk-note').textContent = `${M.gran} cajas · ordenado por ubicación para recorrer la bodega una sola vez`;
  $('pk-tabla').className = 'pk';
  $('pk-tabla').innerHTML = `<thead><tr><th>Ubicación</th><th>SKU</th><th>EAN-13</th><th>Artículo</th>${rutas.map(r => `<th class="rc" style="background:${rutaColor(r)};${claro(rutaColor(r)) ? 'color:#0F172A' : ''}">${r.codigo}<br><small>${esc(rutaColorN(r))}</small></th>`).join('')}<th class="num">Total cajas</th></tr></thead>
  <tbody>${M.filas.map(f => `<tr><td class="code">${esc(f.a.ubicacion || '—')}</td><td class="code">${f.sku}</td><td class="code mini">${esc(f.a.codigo_barras || '')}</td><td>${esc(f.a.nombre || '')}</td>${rutas.map(r => `<td class="c ${f.por[r.id] ? '' : 'z'}">${f.por[r.id] || '·'}</td>`).join('')}<td class="num"><b>${f.total}</b></td></tr>`).join('')}</tbody>
  <tfoot><tr><td colspan="4">Total cajas por ruta</td>${rutas.map(r => `<td class="c">${M.tot[r.id]}</td>`).join('')}<td class="num">${M.gran}</td></tr><tr><td colspan="4" class="mini">Facturas (paquetes)</td>${rutas.map(r => `<td class="c mini">${M.fac[r.id]}</td>`).join('')}<td class="num mini">${Object.values(M.fac).reduce((s, x) => s + x, 0)}</td></tr></tfoot>`;
  $('pk-rutas').innerHTML = rutas.map(r => { const v = veh(r.vehiculo_id) || {}; const q = S.paquetes.filter(x => x.ruta_id === r.id); const col = rutaColor(r); const items = M.filas.filter(f => f.por[r.id]);
    return `<div class="card flat" style="padding:0;overflow:hidden"><div class="banda ${claro(col) ? 'claro' : ''}" style="background:${col};border-radius:0;margin:0"><div><b>${esc(rutaColorN(r)).toUpperCase() || r.codigo}</b><div class="mini" style="color:inherit;opacity:.9">${r.codigo} · ${v.placa} · ${esc(r.conductor || '')}</div></div><div style="text-align:right"><b>${M.tot[r.id]} cajas</b><div class="mini" style="color:inherit;opacity:.9">${M.fac[r.id]} facturas · ${f1(r.peso_kg)} kg</div></div></div>
    <div style="padding:10px 14px"><div class="tw"><table><thead><tr><th>Ubic.</th><th>Artículo</th><th class="num">Cajas</th></tr></thead><tbody>${items.map(f => `<tr><td class="code">${esc(f.a.ubicacion || '')}</td><td>${esc(f.a.nombre || f.sku)}</td><td class="num"><b>${f.por[r.id]}</b></td></tr>`).join('')}</tbody></table></div>
    <div class="row" style="margin-top:10px;justify-content:space-between"><span class="mini">Paquetes: ${q.filter(x => x.impreso_at).length}/${q.length} impresos · ${q.filter(x => PQ_ORD.indexOf(x.estado) >= 2).length}/${q.length} en área</span><div class="row" style="gap:6px">${r.estado === 'simulada' ? '<span class="pill p-mut">Propuesta: publicar para imprimir paquetes</span>' : `<button class="btn sec xs" data-pkq="${r.id}">Imprimir paquetes</button><button class="btn xs" data-area="${r.id}" ${q.length && q.every(x => x.impreso_at) && !pqMin(r.id, 'en_area') ? '' : 'disabled'}>Mercancía y paquetes en área ${esc(rutaColorN(r))}</button>`}</div></div></div></div>`; }).join('');
  document.querySelectorAll('[data-pkq]').forEach(b => b.onclick = () => imprimirPaquetes([b.dataset.pkq]));
  document.querySelectorAll('[data-area]').forEach(b => b.onclick = () => marcarArea(b.dataset.area));
}
function htmlPickingMasivo() {
  const rutas = rutasPk(); const M = matrizPicking(rutas); const f = new Date().toLocaleDateString('es-PA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return `<div class="pp"><h2 style="margin:0">DGP · Lista de picking masivo por ruta</h2><div>${esc(S.bodega ? S.bodega.nombre : '')} · ${f} · ${M.gran} cajas · ${rutas.length} rutas</div>
  <table><thead><tr><th>Ubic.</th><th>SKU</th><th>Artículo</th>${rutas.map(r => `<th class="rc" style="background:${rutaColor(r)};${claro(rutaColor(r)) ? 'color:#000' : ''}">${r.codigo}<br>${esc(rutaColorN(r))}</th>`).join('')}<th class="n">Total</th><th>✓</th></tr></thead>
  <tbody>${M.filas.map(x => `<tr><td>${esc(x.a.ubicacion || '')}</td><td>${x.sku}</td><td>${esc(x.a.nombre || '')}</td>${rutas.map(r => `<td class="c">${x.por[r.id] || ''}</td>`).join('')}<td class="n"><b>${x.total}</b></td><td><span class="chk"></span></td></tr>`).join('')}</tbody>
  <tfoot><tr><td colspan="3">TOTAL CAJAS POR RUTA</td>${rutas.map(r => `<td class="c">${M.tot[r.id]}</td>`).join('')}<td class="n">${M.gran}</td><td></td></tr><tr><td colspan="3">Facturas</td>${rutas.map(r => `<td class="c">${M.fac[r.id]}</td>`).join('')}<td class="n">${Object.values(M.fac).reduce((s, x) => s + x, 0)}</td><td></td></tr></tfoot></table>
  <div class="firmas"><div>Preparó</div><div>Revisó (encargado de bodega)</div><div>Hora fin de picking</div></div></div>`;
}
function htmlSeparacion() {
  const rutas = rutasPk(); const M = matrizPicking(rutas);
  return rutas.map(r => { const v = veh(r.vehiculo_id) || {}; const col = rutaColor(r); return `<div class="pp"><div class="band" style="background:${col};${claro(col) ? 'color:#000' : ''}"><div><div class="big">${esc(rutaColorN(r)).toUpperCase()}</div>Área de separación · ${r.codigo}</div><div style="text-align:right"><div class="big">${M.tot[r.id]} cajas</div>${v.placa} · ${esc(r.conductor || '')} · ${M.fac[r.id]} facturas</div></div>
  <table><thead><tr><th>Ubic.</th><th>SKU</th><th>EAN-13</th><th>Artículo</th><th class="n">Cajas</th><th>Separado</th></tr></thead><tbody>${M.filas.filter(f => f.por[r.id]).map(f => `<tr><td>${esc(f.a.ubicacion || '')}</td><td>${f.sku}</td><td>${esc(f.a.codigo_barras || '')}</td><td>${esc(f.a.nombre || '')}</td><td class="n"><b>${f.por[r.id]}</b></td><td><span class="chk"></span></td></tr>`).join('')}</tbody><tfoot><tr><td colspan="4">Total ${r.codigo}</td><td class="n">${M.tot[r.id]}</td><td></td></tr></tfoot></table>
  <div class="firmas"><div>Separó</div><div>Revisó</div><div>Hora</div></div></div>`; }).join('');
}
function htmlPaquete(q) {
  const r = S.rutas.find(x => x.id === q.ruta_id) || {}; const v = veh(r.vehiculo_id) || {}; const p = pedPq(q); const c = cli(p.cliente_id) || {}; const col = q.color || rutaColor(r); const s = S.paradas.find(x => x.pedido_id === p.id) || {}; const nEnt = S.paradas.filter(x => x.ruta_id === r.id && x.tipo === 'entrega').length;
  const ls = S.lineas.filter(l => l.pedido_id === p.id).map(l => ({ l, a: S.articulos.find(a => a.sku === l.sku) || {} })).sort((x, y) => (x.a.ubicacion || '').localeCompare(y.a.ubicacion || ''));
  const qr = qrData(`${q.numero}|${p.numero_factura}|${r.codigo}`);
  return `<div class="pp"><div class="band" style="background:${col};${claro(col) ? 'color:#000' : ''}"><div><div class="big">PAQUETE</div>${esc(q.numero)}${q.nota && q.nota.startsWith('Reasignado') ? ' · REIMPRESIÓN' : ''}</div><div style="text-align:right"><div class="big">${esc(q.color_nombre || rutaColorN(r)).toUpperCase()}</div>Ruta ${r.codigo} · ${v.placa} · ${esc(r.conductor || '')}</div></div>
  <div style="display:flex;gap:14px;align-items:flex-start"><div class="meta" style="flex:1"><b>Cliente</b><span>${esc(c.nombre)}</span><b>Factura</b><span>${esc(p.numero_factura)} · ${esc(p.numero_so)}</span><b>Dirección</b><span>${esc(c.direccion || '')}</span><b>Entrega</b><span>${s.secuencia || '—'} de ${nEnt} · ETA ${s.eta || '—'}${c.ventana_inicio ? ' · ventana ' + c.ventana_inicio + '–' + c.ventana_fin : ''}</span><b>Contacto</b><span>${esc(c.contacto || '')} ${esc(c.telefono || '')}</span><b>Ejecutivo</b><span>${esc(c.ejecutivo || '')}</span></div>${qr ? `<img src="${qr}" alt="" style="width:86px;height:86px">` : ''}</div>
  <table><thead><tr><th>Ubic.</th><th>SKU</th><th>EAN-13</th><th>Artículo</th><th class="n">Cajas factura</th><th class="n">Cajas mercancía</th><th>OK</th></tr></thead><tbody>${ls.map(({ l, a }) => `<tr><td>${esc(a.ubicacion || '')}</td><td>${l.sku}</td><td>${esc(a.codigo_barras || '')}</td><td>${esc(a.nombre || '')}</td><td class="n"><b>${l.cantidad_cajas}</b></td><td></td><td><span class="chk"></span></td></tr>`).join('')}</tbody><tfoot><tr><td colspan="4">Total</td><td class="n">${ls.reduce((s, x) => s + +x.l.cantidad_cajas, 0)}</td><td></td><td></td></tr></tfoot></table>
  <p style="font-size:9.5pt;margin:8px 0 0">Factura, paquete y mercancía deben coincidir. El conductor dicta los artículos y cantidades de la factura; el verificador compara con este paquete y con la mercancía.</p>
  <div class="firmas"><div>Conductor: ${esc(r.conductor || '')}${q.firma_conductor ? `<img src="${q.firma_conductor}">` : ''}</div><div>Verificador: ${esc(q.verificador || '')}${q.firma_verificador ? `<img src="${q.firma_verificador}">` : ''}</div><div>Envío Zoho Books: ${esc(q.books_shipment_id || '________________')}</div></div></div>`;
}
async function imprimirPaquetes(rids) {
  const qs = S.paquetes.filter(q => rids.includes(q.ruta_id)).sort((a, b) => { const ra = S.rutas.find(r => r.id === a.ruta_id).codigo, rb = S.rutas.find(r => r.id === b.ruta_id).codigo; return ra.localeCompare(rb) || seqDe(b) - seqDe(a); });
  if (!qs.length) { toast('No hay paquetes: publica las rutas primero'); return; }
  imprimir(qs.map(htmlPaquete).join(''));
  const now = new Date().toISOString(); const pend = qs.filter(q => q.estado === 'pendiente');
  for (const q of pend) await DB.update('paquetes', { id: q.id }, { estado: 'impreso', impreso_at: now });
  await DB.audit('paquetes', 'impresion', `${qs.length} paquetes impresos por color de ruta (${[...new Set(qs.map(q => S.rutas.find(r => r.id === q.ruta_id).codigo))].join(', ')}) · orden inverso a la entrega`, ACTOR, false);
  await loadAll(); render();
}
async function marcarArea(rid) {
  const r = S.rutas.find(x => x.id === rid); const qs = S.paquetes.filter(q => q.ruta_id === rid);
  if (qs.some(q => !q.impreso_at)) { toast('Imprime primero todos los paquetes de la ruta'); return; }
  const now = new Date().toISOString(); for (const q of qs.filter(q => PQ_ORD.indexOf(q.estado) < 2)) await DB.update('paquetes', { id: q.id }, { estado: 'en_area', en_area_at: now });
  if (r.estado === 'publicada') await DB.update('rutas', { id: rid }, { estado: 'en_cargue' });
  await DB.audit('paquetes', 'en_area', `${r.codigo}: mercancía separada en el área ${rutaColorN(r)} con cada paquete sobre su pedido (${qs.length})`, ACTOR, false, rid);
  toast(`${r.codigo}: en área ${rutaColorN(r)}`); await loadAll(); render();
}

// ===================== VERIFICACIÓN =====================
async function areaCargue(rid) { const r = S.rutas.find(x => x.id === rid); await DB.update('rutas', { id: rid }, { area_cargue_at: new Date().toISOString() }); await DB.audit('rutas', 'area_cargue', `${r.codigo}: ${r.conductor} revisó la cantidad de facturas, identificó el color ${rutaColorN(r)} y llevó la mercancía al área de cargue`, r.conductor, false, rid); await loadAll(); render(); }
async function llamarVerificador(rid) {
  const r = S.rutas.find(x => x.id === rid); const ver = S.personas.filter(p => p.rol === 'verificador').map(p => p.nombre);
  await DB.update('rutas', { id: rid }, { verificador_llamado_at: new Date().toISOString() });
  for (const v of ver) await DB.notificar('telegram', v, 'verificador', `${r.codigo} lista para verificar`, `${r.conductor} espera en el área de cargue con ${S.paquetes.filter(q => q.ruta_id === rid).length} facturas de la ruta ${r.codigo} (${rutaColorN(r)}). Lleva los paquetes impresos.`, 'llamado al verificador (paso 4)', rid);
  await DB.alerta('verificacion', 'media', `${r.codigo}: el conductor llama al verificador`, `${r.conductor} en el área de cargue · ${rutaColorN(r)}`, 'ruta', ver.join(', '));
  await DB.audit('rutas', 'llamado_verificador', `${r.codigo}: ${r.conductor} llamó al verificador`, r.conductor, false, rid); toast('Verificador notificado'); await loadAll(); render();
}
function pasosRuta(r) {
  const q = S.paquetes.filter(x => x.ruta_id === r.id); const n = q.length; const c = f => q.filter(f).length;
  const P = [
    ['Imprime por color de ruta', c(x => x.impreso_at), n], ['Paquete sobre la mercancía', c(x => PQ_ORD.indexOf(x.estado) >= 2), n],
    ['Conductor en área de cargue', r.area_cargue_at ? 1 : 0, 1, hora(r.area_cargue_at)], ['Llama al verificador', r.verificador_llamado_at ? 1 : 0, 1, hora(r.verificador_llamado_at)],
    ['Dicta y verifica cada artículo', c(x => PQ_ORD.indexOf(x.estado) >= 3), n], ['Firman conductor y verificador', c(x => PQ_ORD.indexOf(x.estado) >= 4), n],
    ['Registra el envío en Books', c(x => PQ_ORD.indexOf(x.estado) >= 5), n], ['Entrega a Gestión Documental', c(x => x.estado === 'entregado_gd'), n]];
  let cur = false; return P.map((p, i) => { const ok = p[2] > 0 && p[1] >= p[2]; const st = ok ? 'ok' : !cur ? (cur = true, 'cur') : ''; return { i: i + 1, t: p[0], v: p[3] || (p[2] > 1 || i !== 2 && i !== 3 ? `${p[1]}/${p[2]}` : ok ? '✔' : '—'), st }; });
}
function renderVerif() {
  const rutas = S.rutas.filter(r => r.estado !== 'simulada').sort((a, b) => a.codigo.localeCompare(b.codigo)); const sel = $('vf-ruta'); const prev = sel.value;
  const pend = rutas.filter(r => ['publicada', 'en_cargue'].includes(r.estado)); $('n-verif').textContent = pend.length; $('n-verif').className = 'n' + (pend.length ? ' hot' : '');
  sel.innerHTML = rutas.map(r => `<option value="${r.id}">${r.codigo} · ${esc(rutaColorN(r))} · ${(veh(r.vehiculo_id) || {}).placa} · ${esc(r.conductor || '')}${listaParaSalir(r.id) ? ' ✔' : ''}</option>`).join('') || '<option value="">Sin rutas publicadas</option>';
  if (rutas.some(r => r.id === prev)) sel.value = prev; else if (pend[0]) sel.value = pend[0].id;
  const r = rutas.find(x => x.id === sel.value);
  if (!r) { $('vf-pasos').innerHTML = '<div class="empty" style="grid-column:1/-1">Publica las rutas para iniciar la verificación de salida.</div>'; $('vf-tb').innerHTML = ''; $('vf-acc').innerHTML = ''; $('vf-log').innerHTML = ''; return; }
  const col = rutaColor(r); const qs = S.paquetes.filter(q => q.ruta_id === r.id).sort((a, b) => seqDe(b) - seqDe(a));
  $('vf-pasos').innerHTML = `<div class="banda ${claro(col) ? 'claro' : ''}" style="background:${col};grid-column:1/-1;margin:0"><div><b>${esc(rutaColorN(r)).toUpperCase()} · ${r.codigo}</b><div class="mini" style="color:inherit">${(veh(r.vehiculo_id) || {}).placa} · conductor ${esc(r.conductor || '')}${r.ayudante ? ' + ' + esc(r.ayudante) : ''}</div></div><div style="text-align:right"><b>${qs.length} facturas · ${r.cajas} cajas</b><div class="mini" style="color:inherit">${rpill(r.estado)}</div></div></div>` + pasosRuta(r).map(p => `<div class="paso ${p.st}"><span class="k">${p.i}</span><b>${p.t}</b>${p.v}</div>`).join('');
  const sal = ['liberada', 'en_ruta', 'cerrada', 'conciliada'].includes(r.estado); const ver = qs.filter(q => q.estado === 'verificado').length, fir = qs.filter(q => q.estado === 'firmado').length;
  $('vf-acc').innerHTML = sal ? `<span class="pill p-ok">Ruta ${r.estado}</span>` : [
    `<button class="btn sec sm" id="vf-print">Imprimir paquetes</button>`,
    !r.area_cargue_at ? `<button class="btn sec sm" id="vf-area">Conductor en área de cargue</button>` : '',
    !r.verificador_llamado_at ? `<button class="btn sec sm" id="vf-llamar">Llamar al verificador</button>` : '',
    ver ? `<button class="btn sm" id="vf-firmar">Firmar ${ver} verificados</button>` : '',
    fir ? `<button class="btn sm info" id="vf-books">Registrar ${fir} envíos en Books</button>` : '',
    `<button class="btn sm" id="vf-liberar" ${listaParaSalir(r.id) ? '' : 'disabled'}>Liberar ruta al conductor</button>`].join('');
  $('vf-tb').innerHTML = qs.map(q => { const p = pedPq(q); const c = cli(p.cliente_id) || {}; return `<tr><td class="code">${esc(q.numero)}${q.nota ? `<div class="mini">${esc(q.nota)}</div>` : ''}</td><td class="num">${seqDe(q) || '—'}</td><td><b>${esc(c.nombre)}</b><br><span class="mini">${esc(p.numero_factura)}${q.verificador ? ' · verificó ' + esc(q.verificador) + ' ' + hora(q.verificado_at) : ''}${q.books_shipment_id ? ' · Books ' + esc(q.books_shipment_id) : ''}</span></td><td class="num">${p.cajas}${+q.faltante_cajas ? `<br><span class="pill p-crit nodot">faltan ${q.faltante_cajas}</span>` : ''}</td><td>${pqPill(q.estado)}</td><td>${!sal && PQ_ORD.indexOf(q.estado) < 5 ? `<button class="btn ${PQ_ORD.indexOf(q.estado) >= 3 ? 'sec' : ''} xs" data-vq="${q.id}">${PQ_ORD.indexOf(q.estado) >= 3 ? 'Revisar' : 'Verificar'}</button>` : ''}</td></tr>`; }).join('') || '<tr><td colspan="6" class="note">Sin paquetes.</td></tr>';
  const cods = new Set(qs.map(q => q.numero)); $('vf-log').innerHTML = S.auditoria.filter(a => (a.detalle || '').includes(r.codigo) || [...cods].some(n => (a.detalle || '').includes(n))).slice(0, 80).map(a => `<div><span>${hora(a.created_at)}</span> <b>${esc(a.accion)}</b> ${esc(a.detalle)} <span>· ${esc(a.actor || '')}</span></div>`).join('') || '<div><span>Sin movimientos.</span></div>';
  const on = (id, f) => { const e = $(id); if (e) e.onclick = f; };
  on('vf-print', () => imprimirPaquetes([r.id])); on('vf-area', () => areaCargue(r.id)); on('vf-llamar', () => llamarVerificador(r.id)); on('vf-firmar', () => firmarTodos(r.id)); on('vf-books', () => registrarBooks(r.id)); on('vf-liberar', () => liberar(r.id));
  document.querySelectorAll('[data-vq]').forEach(b => b.onclick = () => verificarPaquete(b.dataset.vq));
}
function firmaPad(cv) {
  const ctx = cv.getContext('2d'); const k = window.devicePixelRatio || 1; cv.width = cv.offsetWidth * k; cv.height = cv.offsetHeight * k; ctx.scale(k, k); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.strokeStyle = '#0F172A'; let d = false, n = 0;
  const pos = e => { const b = cv.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return [t.clientX - b.left, t.clientY - b.top]; };
  const down = e => { e.preventDefault(); d = true; const [x, y] = pos(e); ctx.beginPath(); ctx.moveTo(x, y); }; const move = e => { if (!d) return; e.preventDefault(); const [x, y] = pos(e); ctx.lineTo(x, y); ctx.stroke(); n++; }; const up = () => { d = false; };
  cv.addEventListener('mousedown', down); cv.addEventListener('mousemove', move); window.addEventListener('mouseup', up); cv.addEventListener('touchstart', down, { passive: false }); cv.addEventListener('touchmove', move, { passive: false }); cv.addEventListener('touchend', up);
  return { vacia: () => n < 5, url: () => cv.toDataURL('image/png'), limpiar: () => { ctx.clearRect(0, 0, cv.width, cv.height); n = 0; } };
}
function verificarPaquete(qid) {
  const q = S.paquetes.find(x => x.id === qid); const r = S.rutas.find(x => x.id === q.ruta_id); const p = pedPq(q); const c = cli(p.cliente_id) || {}; const col = q.color || rutaColor(r);
  const prev = {}; (q.lineas || []).forEach(l => prev[l.sku] = l.mercancia);
  const L = S.lineas.filter(l => l.pedido_id === p.id).map(l => ({ sku: l.sku, a: S.articulos.find(a => a.sku === l.sku) || {}, factura: +l.cantidad_cajas, paquete: +l.cantidad_cajas, mercancia: prev[l.sku] ?? '' }));
  modal(`<div class="banda ${claro(col) ? 'claro' : ''}" style="background:${col}"><div><b>${esc(q.numero)}</b><div class="mini" style="color:inherit">${esc(c.nombre)} · ${esc(p.numero_factura)}</div></div><div style="text-align:right"><b>${esc(q.color_nombre || rutaColorN(r)).toUpperCase()}</b><div class="mini" style="color:inherit">${r.codigo} · ${esc(r.conductor)}</div></div></div>
  <div class="note" style="margin-bottom:8px"><b>Paso 5.</b> El conductor dicta artículos y cantidades de la factura; tú comparas con el paquete y cuentas la mercancía. Escanea el EAN-13 de la caja para marcar la línea, o escribe las cajas contadas.</div>
  <div class="row" style="margin-bottom:8px"><input id="vq-scan" placeholder="Escanear EAN-13 o SKU (Enter)" style="flex:1;font-family:var(--mono)"><button class="btn sec sm" id="vq-todo">Todo coincide</button></div>
  <div class="tw"><table class="vtab"><thead><tr><th>Artículo</th><th class="num">Factura</th><th class="num">Paquete</th><th class="num">Mercancía</th><th>Resultado</th></tr></thead><tbody id="vq-tb"></tbody></table></div>
  <label class="f" style="margin-top:8px">Nota (obligatoria si hay diferencia)<input id="vq-nota" value="${esc(q.nota && !q.nota.startsWith('Reasignado') ? q.nota : '')}" placeholder="Ej.: faltan 2 cajas de cloro, sin stock en ubicación A-02"></label>
  <div class="note" style="margin-top:10px"><b>Paso 6.</b> Firman conductor y verificador (o firma todos los paquetes verificados al final desde la lista).</div>
  <div class="firmas"><div><div class="mini">Conductor · ${esc(r.conductor)}</div><canvas class="firma" id="vq-f1"></canvas></div><div><div class="mini">Verificador · ${esc(ACTOR)}</div><canvas class="firma" id="vq-f2"></canvas></div></div>
  <div id="vq-msg" class="note" style="margin-top:8px"></div>
  <div class="row" style="margin-top:12px;justify-content:flex-end"><button class="btn sec" id="vq-x">Cerrar</button><button class="btn sec" id="vq-solo">Guardar verificación</button><button class="btn warn" id="vq-falt" style="display:none">Registrar faltante y continuar</button><button class="btn" id="vq-ok">Verificar y firmar</button></div>`);
  $('modal-body').classList.add('wide');
  const f1p = firmaPad($('vq-f1')), f2p = firmaPad($('vq-f2'));
  const draw = () => { $('vq-tb').innerHTML = L.map((l, i) => { const m = l.mercancia === '' ? null : +l.mercancia; const ok = m === l.factura; return `<tr class="${m == null ? '' : ok ? 'okl' : 'dif'}"><td><b>${esc(l.a.nombre || l.sku)}</b><br><span class="mini code">${l.sku} · ${esc(l.a.codigo_barras || '')} · ${esc(l.a.ubicacion || '')}</span></td><td class="num">${l.factura}</td><td class="num">${l.paquete}</td><td class="num"><input type="number" min="0" inputmode="numeric" data-vm="${i}" value="${m ?? ''}"></td><td>${m == null ? '<span class="pill p-mut">Por contar</span>' : ok ? '<span class="pill p-ok">Coincide</span>' : m < l.factura ? `<span class="pill p-crit">Faltan ${l.factura - m}</span>` : `<span class="pill p-warn">Sobran ${m - l.factura}</span>`}</td></tr>`; }).join('');
    document.querySelectorAll('[data-vm]').forEach(i => i.onchange = () => { L[+i.dataset.vm].mercancia = i.value === '' ? '' : +i.value; draw(); });
    const dif = L.filter(l => l.mercancia !== '' && +l.mercancia !== l.factura); const falt = L.filter(l => l.mercancia !== '' && +l.mercancia < l.factura); const sob = L.filter(l => l.mercancia !== '' && +l.mercancia > l.factura); const pend = L.filter(l => l.mercancia === '');
    $('vq-msg').innerHTML = pend.length ? `${pend.length} líneas por contar.` : sob.length ? '<b style="color:var(--crit)">Hay mercancía de más: retírala antes de firmar.</b>' : falt.length ? `<b style="color:var(--crit)">Factura, paquete y mercancía no coinciden.</b> Completa la mercancía o registra el faltante (se avisa a Facturación y al ejecutivo; cuenta en incentivos).` : '<b style="color:var(--ok)">Factura, paquete y mercancía coinciden.</b>';
    $('vq-ok').style.display = dif.length ? 'none' : ''; $('vq-falt').style.display = falt.length && !sob.length && !pend.length ? '' : 'none'; };
  draw();
  $('vq-scan').onkeydown = e => { if (e.key !== 'Enter') return; const v = e.target.value.trim(); e.target.value = ''; const l = L.find(x => x.sku === v || x.a.codigo_barras === v); if (!l) { const otro = S.articulos.find(a => a.codigo_barras === v || a.sku === v); toast(otro ? `${otro.nombre} NO está en esta factura` : `Código ${v} no existe`); return; } l.mercancia = l.factura; draw(); };
  $('vq-todo').onclick = () => { L.forEach(l => l.mercancia = l.factura); draw(); };
  $('vq-x').onclick = () => { $('modal-body').classList.remove('wide'); closeModal(); };
  const guardar = async (firmar, faltante) => {
    if (!exige('verificar')) return; if (L.some(l => l.mercancia === '')) { toast('Cuenta todas las líneas'); return; }
    const falt = L.reduce((s, l) => s + Math.max(0, l.factura - +l.mercancia), 0); const nota = $('vq-nota').value.trim();
    if (falt && !nota) { toast('Escribe la nota del faltante'); return; } if (firmar && (f1p.vacia() || f2p.vacia())) { toast('Faltan las dos firmas'); return; }
    const now = new Date().toISOString(); const patch = { lineas: L.map(l => ({ sku: l.sku, factura: l.factura, paquete: l.paquete, mercancia: +l.mercancia })), diferencias: L.filter(l => +l.mercancia !== l.factura).length, faltante_cajas: falt, nota: nota || null, verificador: ACTOR, verificado_at: now, estado: 'verificado' };
    if (firmar) Object.assign(patch, { firma_conductor: f1p.url(), firma_verificador: f2p.url(), firmado_at: now, estado: 'firmado' });
    await DB.update('paquetes', { id: q.id }, patch);
    if (faltante) {
      const val = L.reduce((s, l) => s + Math.max(0, l.factura - +l.mercancia) * +(S.lineas.find(x => x.pedido_id === p.id && x.sku === l.sku) || {}).precio, 0);
      await DB.insert('incidencias', { ruta_id: r.id, tipo: 'faltante', descripcion: `${q.numero} ${p.numero_factura}: ${nota}`, estado: 'registrada', actor: ACTOR, monto: +val.toFixed(2), cliente_id: c.id, created_at: now });
      const fac = (S.personas.find(x => x.rol === 'facturacion') || {}).nombre || 'Facturación';
      await DB.notificar('telegram', fac, 'facturacion', `Faltante en ${p.numero_factura}`, `${q.numero} (${r.codigo}): faltan ${falt} cajas · B/. ${fmt(val)}. ${nota}. Ajustar factura / nota de crédito en Books antes de entregar.`, 'faltante en verificación', r.id);
      await DB.notificar('telegram', c.ejecutivo, 'ejecutivo', `Faltante · ${c.nombre}`, `${p.numero_factura} sale con ${falt} cajas menos (${nota}). Avisa al cliente.`, 'faltante en verificación', r.id);
    }
    await DB.audit('paquetes', firmar ? 'verificado_firmado' : 'verificado', `${q.numero} ${p.numero_factura} (${r.codigo}): ${falt ? 'FALTANTE ' + falt + ' cajas · ' + nota : 'factura, paquete y mercancía coinciden'}${firmar ? ' · firmado por ' + r.conductor + ' y ' + ACTOR : ''}`, ACTOR, false, q.id);
    $('modal-body').classList.remove('wide'); closeModal(); toast(firmar ? 'Paquete verificado y firmado' : 'Verificación guardada'); await loadAll(); render();
  };
  $('vq-solo').onclick = () => guardar(false, L.some(l => l.mercancia !== '' && +l.mercancia < l.factura)); $('vq-ok').onclick = () => guardar(true, false);
  $('vq-falt').onclick = () => guardar(!(f1p.vacia() || f2p.vacia()), true);
}
function firmarTodos(rid) {
  const r = S.rutas.find(x => x.id === rid); const qs = S.paquetes.filter(q => q.ruta_id === rid && q.estado === 'verificado');
  modal(`<h2>Firmar ${qs.length} paquetes verificados · ${r.codigo}</h2><div class="note" style="margin:6px 0 10px">Paso 6: el conductor firma el paquete y el verificador también firma todos los paquetes. La firma se aplica a: ${qs.map(q => esc(q.numero)).join(', ')}.</div>
  <div class="firmas"><div><div class="mini">Conductor · ${esc(r.conductor)}</div><canvas class="firma" id="ft-1"></canvas></div><div><div class="mini">Verificador · ${esc(ACTOR)}</div><canvas class="firma" id="ft-2"></canvas></div></div>
  <div class="row" style="margin-top:12px;justify-content:flex-end"><button class="btn sec" id="ft-x">Cancelar</button><button class="btn" id="ft-ok">Firmar todos</button></div>`);
  const a = firmaPad($('ft-1')), b = firmaPad($('ft-2')); $('ft-x').onclick = closeModal;
  $('ft-ok').onclick = async () => { if (!exige('verificar')) return; if (a.vacia() || b.vacia()) { toast('Faltan las dos firmas'); return; } const now = new Date().toISOString(); const u1 = a.url(), u2 = b.url();
    for (const q of qs) await DB.update('paquetes', { id: q.id }, { firma_conductor: u1, firma_verificador: u2, firmado_at: now, estado: 'firmado' });
    await DB.audit('paquetes', 'firmado', `${r.codigo}: ${qs.length} paquetes firmados por ${r.conductor} (conductor) y ${ACTOR} (verificador)`, ACTOR, false, rid); closeModal(); toast('Paquetes firmados'); await loadAll(); render(); };
}
/* Paso 7. Con la integración de Zoho activa crea paquete y envío en Inventory (o, en modo solo Books, comentario en la orden) (Edge Function "zoho");
   si no, queda SIMULADO (id "SIM-…", marcado como tal en la auditoría). */
async function registrarBooks(rid) {
  if (!exige('verificar')) return; const r = S.rutas.find(x => x.id === rid); const qs = S.paquetes.filter(q => q.ruta_id === rid && q.estado === 'firmado'); const now = new Date().toISOString(); const d = hoy().replace(/-/g, '').slice(2);
  const real = zohoActivo();
  if (!real) {
    for (const q of qs) await DB.update('paquetes', { id: q.id }, { estado: 'registrado', books_shipment_id: `SIM-${d}-${q.numero.replace(/\D/g, '').slice(-6)}`, books_registrado_at: now, books_registrado_por: ACTOR });
    await DB.audit('paquetes', 'books_envio', `${r.codigo}: ${qs.length} envíos marcados como registrados con el conductor ${r.conductor} (SIMULADO: integración Zoho no activa)`, ACTOR, false, rid);
    toast(`${qs.length} envíos registrados (simulado: Zoho no está conectado)`); await loadAll(); render(); return;
  }
  let ok = 0; const errs = [];
  for (const q of qs) {
    try { await DB.fn('zoho', { accion: 'registrar_envio', paquete_id: q.id }); await DB.update('paquetes', { id: q.id }, { estado: 'registrado' }); ok++; }
    catch (e) { errs.push(`${q.numero}: ${e.message}`); }
  }
  await DB.audit('paquetes', 'books_envio', `${r.codigo}: ${ok} de ${qs.length} despachos registrados en Zoho${errs.length ? ' · errores: ' + errs.join(' | ') : ''}`, ACTOR, false, rid);
  if (errs.length) { await DB.alerta('zoho', 'alta', `${r.codigo}: ${errs.length} envíos no se registraron en Zoho`, errs.join(' · ').slice(0, 900), 'ruta', 'Verificador'); toast(`${ok} registrados · ${errs.length} con error (ver alertas)`); }
  else toast(`${ok} despachos registrados en Zoho`);
  await loadAll(); render();
}

// ===================== GESTIÓN DOCUMENTAL =====================
function renderGD() {
  const rutas = S.rutas.filter(r => r.estado !== 'simulada').sort((a, b) => a.codigo.localeCompare(b.codigo)); const all = S.paquetes.filter(q => rutas.some(r => r.id === q.ruta_id));
  const enB = all.filter(q => q.estado === 'en_bodega');
  $('gd-kpis').innerHTML = [['Paquetes del día', all.length, `${rutas.length} rutas`], ['Firmados y en Books', all.filter(q => PQ_ORD.indexOf(q.estado) >= 5).length, `${all.filter(q => PQ_ORD.indexOf(q.estado) < 4).length} sin firmar`], ['Con encargado de bodega', enB.length, 'por entregar a Gestión Documental'], ['Entregados a GD', all.filter(q => q.estado === 'entregado_gd').length, `${S.actas.length} actas`]].map(k => `<div class="tile"><div class="l">${k[0]}</div><div class="v" style="font-size:24px">${k[1]}</div><div class="s">${k[2]}</div></div>`).join('');
  $('gd-entregar').disabled = !enB.length;
  $('gd-rutas').innerHTML = rutas.map(r => { const q = all.filter(x => x.ruta_id === r.id); const reg = q.filter(x => x.estado === 'registrado'); const sinF = q.filter(x => PQ_ORD.indexOf(x.estado) < 5); return `<div class="card flat veh" style="--vc:${rutaColor(r)};padding:10px 14px"><div class="hd" style="margin-bottom:4px"><div><span class="swatch" style="background:${rutaColor(r)}"></span><b>${r.codigo}</b> · ${esc(rutaColorN(r))} · ${esc(r.conductor || '')}<div class="mini">${q.length} paquetes · ${q.filter(x => x.estado === 'entregado_gd').length} en GD · ${q.filter(x => x.estado === 'en_bodega').length} con encargado${sinF.length ? ` · <b style="color:var(--crit)">${sinF.length} sin firmar/registrar</b>` : ''}</div></div>${reg.length ? `<button class="btn xs" data-gdr="${r.id}">Recibir ${reg.length} firmados</button>` : q.length && q.every(x => x.estado === 'entregado_gd') ? '<span class="pill p-ok">Completo</span>' : ''}</div></div>`; }).join('') || '<div class="empty">Sin rutas publicadas.</div>';
  $('gd-actas').innerHTML = S.actas.map(a => `<tr><td class="code">${esc(a.numero)}</td><td>${hora(a.created_at)}</td><td>${esc(a.encargado)}</td><td>${esc(a.recibe)}</td><td class="num">${a.paquetes}</td><td class="mini">${esc((a.rutas || []).join(', '))}</td><td><button class="btn sec xs" data-acta="${a.id}">Imprimir</button></td></tr>`).join('') || '<tr><td colspan="7" class="note">Sin actas todavía.</td></tr>';
  document.querySelectorAll('[data-gdr]').forEach(b => b.onclick = () => recibirEncargado(b.dataset.gdr)); document.querySelectorAll('[data-acta]').forEach(b => b.onclick = () => imprimirActa(b.dataset.acta));
}
async function recibirEncargado(rid) { if (!exige('gd')) return; const r = S.rutas.find(x => x.id === rid); const qs = S.paquetes.filter(q => q.ruta_id === rid && q.estado === 'registrado'); const now = new Date().toISOString(); for (const q of qs) await DB.update('paquetes', { id: q.id }, { estado: 'en_bodega', encargado: ACTOR, recibido_encargado_at: now }); await DB.audit('paquetes', 'recibido_encargado', `${r.codigo}: ${ACTOR} recibió ${qs.length} paquetes firmados`, ACTOR, false, rid); toast(`${qs.length} paquetes recibidos`); await loadAll(); render(); }
function entregarGD() {
  const qs = S.paquetes.filter(q => q.estado === 'en_bodega'); const gd = S.personas.filter(p => p.rol === 'gestion_documental'); const rs = [...new Set(qs.map(q => (S.rutas.find(r => r.id === q.ruta_id) || {}).codigo))].sort();
  modal(`<h2>Entrega a Gestión Documental</h2><div class="note" style="margin:6px 0 10px">${qs.length} paquetes firmados de ${rs.length} rutas (${rs.join(', ')}). Se genera un acta con la lista.</div>
  <label class="f">Recibe<select id="gd-rec">${gd.map(p => `<option>${esc(p.nombre)}</option>`).join('')}</select></label><label class="f" style="margin-top:8px">Observaciones<input id="gd-obs" placeholder="Opcional"></label>
  <div class="row" style="margin-top:12px;justify-content:flex-end"><button class="btn sec" id="gd-x">Cancelar</button><button class="btn" id="gd-ok">Entregar y generar acta</button></div>`);
  $('gd-x').onclick = closeModal;
  $('gd-ok').onclick = async () => { if (!exige('gd')) return; const n = S.actas.filter(a => a.fecha === hoy()).length + 1; const acta = { id: DB.uuid(), numero: `ACT-${hoy().replace(/-/g, '')}-${n}`, fecha: hoy(), encargado: ACTOR, recibe: $('gd-rec').value, paquetes: qs.length, rutas: rs, observaciones: $('gd-obs').value };
    await DB.insert('actas_gd', [acta]); for (const q of qs) await DB.update('paquetes', { id: q.id }, { estado: 'entregado_gd', acta_id: acta.id });
    await DB.audit('paquetes', 'entrega_gd', `${acta.numero}: ${ACTOR} entregó ${qs.length} paquetes firmados (${rs.join(', ')}) a ${acta.recibe} de Gestión Documental`, ACTOR, false, acta.id); closeModal(); toast(`Acta ${acta.numero} generada`); await loadAll(); render(); imprimirActa(acta.id); };
}
function imprimirActa(id) {
  const a = S.actas.find(x => x.id === id); if (!a) return; const qs = S.paquetes.filter(q => q.acta_id === id).sort((x, y) => x.numero.localeCompare(y.numero));
  imprimir(`<div class="pp"><h2 style="margin:0">DGP · Acta de entrega a Gestión Documental</h2><div class="meta"><b>Acta</b><span>${esc(a.numero)}</span><b>Fecha</b><span>${new Date(a.created_at).toLocaleString('es-PA')}</span><b>Entrega</b><span>${esc(a.encargado)} (encargado de bodega)</span><b>Recibe</b><span>${esc(a.recibe)}</span></div>
  <table><thead><tr><th>Ruta</th><th>Color</th><th>Paquete</th><th>Factura</th><th>Cliente</th><th>Verificador</th><th>Envío Books</th></tr></thead><tbody>${qs.map(q => { const r = S.rutas.find(x => x.id === q.ruta_id) || {}; const p = pedPq(q); return `<tr><td>${r.codigo || ''}</td><td>${esc(q.color_nombre || '')}</td><td>${esc(q.numero)}</td><td>${esc(p.numero_factura || '')}</td><td>${esc((cli(p.cliente_id) || {}).nombre || '')}</td><td>${esc(q.verificador || '')}</td><td>${esc(q.books_shipment_id || '')}</td></tr>`; }).join('')}</tbody><tfoot><tr><td colspan="7">Total: ${qs.length} paquetes firmados</td></tr></tfoot></table>
  ${a.observaciones ? `<p>Observaciones: ${esc(a.observaciones)}</p>` : ''}<div class="firmas"><div>Entrega: ${esc(a.encargado)}</div><div>Recibe: ${esc(a.recibe)}</div><div>Hora</div></div></div>`);
}

// ===================== AVISOS =====================
const CANAL = { whatsapp_cliente: ['WhatsApp cliente', 'p-ok'], telegram: ['Telegram', 'p-info'], correo: ['Correo', 'p-vio'] };
function renderAvisos() {
  const f = $('av-canal').value; const N = S.notificaciones; const rows = N.filter(n => !f || (n.canal || '').startsWith(f));
  $('n-avisos').textContent = N.length;
  $('av-kpis').innerHTML = [['Avisos generados', N.length, 'hoy'], ['WhatsApp a clientes', N.filter(n => n.canal === 'whatsapp_cliente').length, 'salida, hora estimada, demoras'], ['Telegram interno', N.filter(n => n.canal === 'telegram').length, 'ejecutivos, gerencia, conductor, verificador'], ['Correo', N.filter(n => n.canal === 'correo').length, 'dominio dgp.com.pa']].map(k => `<div class="tile"><div class="l">${k[0]}</div><div class="v" style="font-size:24px">${k[1]}</div><div class="s">${k[2]}</div></div>`).join('');
  $('av-tb').innerHTML = rows.slice(0, 300).map(n => { const c = CANAL[n.canal] || [n.canal, 'p-mut']; const r = S.rutas.find(x => x.id === n.ruta_id); return `<tr><td class="code">${hora(n.created_at)}${r ? `<br><span class="mini" style="color:${rutaColor(r)}">${r.codigo}</span>` : ''}</td><td><span class="pill ${c[1]} nodot">${c[0]}</span></td><td><b>${esc(n.destinatario)}</b><br><span class="mini">${esc(ROL_N[n.rol] || n.rol || '')}</span></td><td class="mini">${esc(n.motivo || '')}</td><td>${esc(n.mensaje)}</td><td><span class="pill p-mut nodot">${esc(n.estado)}</span></td></tr>`; }).join('') || '<tr><td colspan="6" class="note">Sin avisos todavía. Se generan al publicar rutas bajo el mínimo, al salir una ruta, al reportar una demora, al llamar al verificador y al registrar faltantes.</td></tr>';
}

// ===================== EVENTOS =====================
$('pk-filtro').onchange = renderPicking;
$('pk-print').onclick = () => { if (!rutasPk().length) return toast('Sin rutas'); imprimir(htmlPickingMasivo()); DB.audit('picking', 'impresion', `Lista de picking masivo impresa: ${rutasPk().map(r => r.codigo).join(', ')}`, ACTOR, false); };
$('pk-print-sep').onclick = () => { if (!rutasPk().length) return toast('Sin rutas'); imprimir(htmlSeparacion()); };
$('pk-paq').onclick = () => imprimirPaquetes(rutasPk().filter(r => r.estado !== 'simulada').map(r => r.id));
$('pk-csv').onclick = () => { const rutas = rutasPk(); const M = matrizPicking(rutas); if (!rutas.length) return toast('Sin rutas'); const h = ['Ubicación', 'SKU', 'EAN-13', 'Artículo', ...rutas.map(r => `${r.codigo} ${rutaColorN(r)}`), 'Total cajas']; const d = M.filas.map(f => [f.a.ubicacion || '', f.sku, f.a.codigo_barras || '', f.a.nombre || '', ...rutas.map(r => f.por[r.id] || 0), f.total]); d.push(['', '', '', 'TOTAL CAJAS POR RUTA', ...rutas.map(r => M.tot[r.id]), M.gran]); d.push(['', '', '', 'Facturas', ...rutas.map(r => M.fac[r.id]), Object.values(M.fac).reduce((s, x) => s + x, 0)]); descargarCSV(`picking_masivo_${hoy()}.csv`, [h, ...d]); };
$('vf-ruta').onchange = renderVerif; $('gd-entregar').onclick = entregarGD; $('av-canal').onchange = renderAvisos;
