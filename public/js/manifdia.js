/* DGP · Manifiesto del día (20-nov-2026).
   - Manifiesto total: una sola línea por SKU con la suma de todas las facturas de los camiones marcados.
   - Manifiesto por camión: agrupa todas las rutas/viajes del mismo vehículo en la fecha; una sola línea por SKU con la suma.
   - Cada camión se imprime en su propia página; se puede imprimir uno, los marcados o el total + los marcados.
   Fuente: líneas de los pedidos asignados a rutas publicadas (no simuladas) de la fecha, igual que el manifiesto por ruta. */
const MD = { fecha: '', excl: new Set() };
const mdSku = s => String(s == null ? '' : s).trim();
const mdN = n => (+n || 0).toLocaleString('es-PA', { maximumFractionDigits: 2 });

function mdFechas() { return [...new Set(S.rutas.filter(r => r.estado !== 'simulada' && r.fecha).map(r => r.fecha))].sort().reverse(); }
function mdRutas(fecha) { return S.rutas.filter(r => r.estado !== 'simulada' && r.fecha === fecha && r.vehiculo_id).sort((a, b) => (a.codigo || '').localeCompare(b.codigo || '')); }
/* Camiones de la fecha: { id, v, rutas[] } ordenados por placa. */
function mdCamiones(fecha) {
  const g = {};
  mdRutas(fecha).forEach(r => { const k = r.vehiculo_id; (g[k] = g[k] || { id: k, v: veh(k) || {}, rutas: [] }).rutas.push(r); });
  return Object.values(g).sort((a, b) => (a.v.placa || '').localeCompare(b.v.placa || ''));
}
/* Consolida por SKU. clave(r) decide la columna de desglose (camión en el total, ruta/viaje en el camión). */
function mdConsolidar(rutas, clave) {
  const m = new Map(); const facs = new Set(); const porCol = {};
  rutas.forEach(r => S.pedidos.filter(p => p.ruta_id === r.id).forEach(p => {
    facs.add(p.id);
    S.lineas.filter(l => l.pedido_id === p.id).forEach(l => {
      const k = mdSku(l.sku); if (!k) return; const q = +l.cantidad_cajas || 0; const c = clave(r);
      const x = m.get(k) || { sku: k, total: 0, por: {}, facturas: new Set() };
      x.total += q; x.por[c] = (x.por[c] || 0) + q; x.facturas.add(p.numero_factura || p.numero_so); m.set(k, x);
      porCol[c] = (porCol[c] || 0) + q;
    });
  }));
  const art = sku => S.articulos.find(a => mdSku(a.sku) === sku) || {};
  const filas = [...m.values()].map(x => Object.assign(x, { a: art(x.sku) }))
    .sort((x, y) => (x.a.ubicacion || 'ZZZ').localeCompare(y.a.ubicacion || 'ZZZ') || x.sku.localeCompare(y.sku));
  return { filas, total: filas.reduce((s, x) => s + x.total, 0), facturas: facs.size, porCol };
}
const mdMarcados = () => mdCamiones(MD.fecha).filter(c => !MD.excl.has(c.id));
/* Anchos fijos en % para que la tabla impresa no se descuadre: cada número es una columna; null = la descripción, que se queda con lo que sobra. */
function mdColgroup(anchos) {
  const resto = Math.max(16, 100 - anchos.reduce((t, x) => t + (x || 0), 0));
  return '<colgroup>' + anchos.map(x => `<col style="width:${(x == null ? resto : x).toFixed(1)}%">`).join('') + '</colgroup>';
}
const mdConductores = c => [...new Set(c.rutas.map(r => r.conductor).filter(Boolean))].join(', ');
const mdAyudantes = c => [...new Set(c.rutas.map(r => r.ayudante).filter(Boolean))].join(', ');

// ===================== PANTALLA =====================
function renderManifDia() {
  const sel = $('md-fecha'); if (!sel) return;
  const fechas = mdFechas();
  if (!MD.fecha || !fechas.includes(MD.fecha)) MD.fecha = fechas.includes(hoy()) ? hoy() : (fechas[0] || '');
  sel.innerHTML = fechas.length ? fechas.map(f => `<option value="${f}">${f}${f === hoy() ? ' (hoy)' : ''}</option>`).join('') : '<option value="">Sin rutas publicadas</option>';
  sel.value = MD.fecha;
  const cams = mdCamiones(MD.fecha);
  if (!cams.length) { $('md-cams').innerHTML = '<div class="empty">Aprueba y publica las rutas en Planificación para generar el manifiesto del día.</div>'; $('md-total').innerHTML = ''; return; }
  const filasCam = cams.map(c => { const k = mdConsolidar(c.rutas, r => r.id); return `<tr>
    <td><input type="checkbox" data-mdcam="${c.id}" ${MD.excl.has(c.id) ? '' : 'checked'}></td>
    <td class="code"><b>${esc(c.v.placa || '—')}</b><br><span class="mini">${esc(c.v.nombre || '')}</span></td>
    <td>${esc(mdConductores(c) || '—')}</td>
    <td>${c.rutas.map(r => `<span class="swatch" style="background:${rutaColor(r)}"></span>${esc(r.codigo)} <span class="mini">${esc(zona(r.zona_codigo).nombre || '')}</span>`).join('<br>')}</td>
    <td class="num">${k.facturas}</td><td class="num">${k.filas.length}</td><td class="num"><b>${mdN(k.total)}</b></td>
    <td><button class="btn sec sm" data-mdprint="${c.id}">Imprimir</button></td></tr>`; }).join('');
  $('md-cams').innerHTML = `<div class="tw"><table><thead><tr><th><input type="checkbox" id="md-all" ${cams.every(c => !MD.excl.has(c.id)) ? 'checked' : ''} title="Marcar todos"></th><th>Camión</th><th>Conductor</th><th>Rutas / viajes</th><th class="num">Facturas</th><th class="num">SKUs</th><th class="num">Cantidad</th><th></th></tr></thead><tbody>${filasCam}</tbody></table></div>`;
  const marc = mdMarcados(); const T = mdConsolidar(marc.flatMap(c => c.rutas), r => r.vehiculo_id);
  $('md-total').innerHTML = marc.length ? `<h3 style="margin:14px 0 6px">Total del día · ${marc.length} camión(es) · ${T.filas.length} SKUs · ${mdN(T.total)} unidades · ${T.facturas} facturas</h3>
    <div class="tw"><table><thead><tr><th>Ubicación</th><th>SKU</th><th>Artículo</th>${marc.map(c => `<th class="num">${esc(c.v.placa || '')}</th>`).join('')}<th class="num">Total</th></tr></thead>
    <tbody>${T.filas.map(x => `<tr><td class="code">${esc(x.a.ubicacion || '')}</td><td class="code">${esc(x.sku)}</td><td>${esc(x.a.nombre || 'Artículo no encontrado en el catálogo')}</td>${marc.map(c => `<td class="num">${x.por[c.id] ? mdN(x.por[c.id]) : '<span class="mini">·</span>'}</td>`).join('')}<td class="num"><b>${mdN(x.total)}</b></td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="3"><b>Total</b></td>${marc.map(c => `<td class="num"><b>${mdN(T.porCol[c.id] || 0)}</b></td>`).join('')}<td class="num"><b>${mdN(T.total)}</b></td></tr></tfoot></table></div>`
    : '<div class="empty">Marca al menos un camión.</div>';
  document.querySelectorAll('[data-mdcam]').forEach(x => x.onchange = () => { x.checked ? MD.excl.delete(x.dataset.mdcam) : MD.excl.add(x.dataset.mdcam); renderManifDia(); });
  document.querySelectorAll('[data-mdprint]').forEach(x => x.onclick = () => mdImprimir([cams.find(c => c.id === x.dataset.mdprint)], false));
  const all = $('md-all'); if (all) all.onchange = () => { cams.forEach(c => all.checked ? MD.excl.delete(c.id) : MD.excl.add(c.id)); renderManifDia(); };
}

// ===================== IMPRESIÓN =====================
/* Todo el manifiesto del día sale en horizontal (sin «páginas con nombre»: en Chrome generaban una primera página en blanco). */
function mdPrint(html) {
  let st = document.getElementById('md-page'); if (!st) { st = document.createElement('style'); st.id = 'md-page'; document.head.appendChild(st); }
  st.textContent = '@media print{@page{size:letter landscape;margin:10mm}}';
  const fin = () => { st.textContent = ''; window.removeEventListener('afterprint', fin); }; window.addEventListener('afterprint', fin);
  imprimir(html);
}
const mdConUbic = filas => filas.some(x => x.a.ubicacion);
function mdHtmlTotal(cams) {
  const T = mdConsolidar(cams.flatMap(c => c.rutas), r => r.vehiculo_id); const n = cams.length;
  const wc = Math.min(8, 42 / Math.max(n, 1)); const U = mdConUbic(T.filas); // columna por camión; Ubic. solo si algún artículo la tiene
  return `<div class="pp md tot"><div class="band" style="background:#0F172A"><div><div class="big">Manifiesto total</div>${esc(MD.fecha)} · ${n} camión(es)</div><div style="text-align:right"><div class="big">${mdN(T.total)}</div>${T.filas.length} SKUs · ${T.facturas} facturas</div></div>
   <div class="meta"><b>Camiones</b><span style="grid-column:2/-1">${cams.map(c => `${esc(c.v.placa || '')} (${c.rutas.map(r => esc(r.codigo)).join(', ')})`).join(' · ')}</span></div>
   <table>${mdColgroup([...(U ? [5] : []), 13, null, ...cams.map(() => wc), 7, 6.5])}<thead><tr>${U ? '<th>Ubic.</th>' : ''}<th>SKU</th><th>Artículo</th>${cams.map(c => `<th class="n pl">${esc(c.v.placa || '')}</th>`).join('')}<th class="n">Total</th><th>Sacado</th></tr></thead>
   <tbody>${T.filas.map(x => `<tr>${U ? `<td>${esc(x.a.ubicacion || '')}</td>` : ''}<td class="nw">${esc(x.sku)}</td><td>${esc(x.a.nombre || '')}</td>${cams.map(c => `<td class="n">${x.por[c.id] ? mdN(x.por[c.id]) : ''}</td>`).join('')}<td class="n"><b>${mdN(x.total)}</b></td><td class="ck"><span class="chk"></span></td></tr>`).join('')}</tbody>
   <tfoot><tr><td colspan="${U ? 3 : 2}">Total</td>${cams.map(c => `<td class="n">${mdN(T.porCol[c.id] || 0)}</td>`).join('')}<td class="n">${mdN(T.total)}</td><td></td></tr></tfoot></table>
   <div class="firmas"><div>Preparó (bodega)</div><div>Jefe de bodega</div><div>Hora</div></div></div>`;
}
function mdHtmlCamion(c) {
  const K = mdConsolidar(c.rutas, r => r.id); const varios = c.rutas.length > 1; const U = mdConUbic(K.filas);
  const col = varios ? '#0F172A' : rutaColor(c.rutas[0]); const txt = !varios && claro(col) ? 'color:#000' : '';
  const facsRuta = r => S.pedidos.filter(p => p.ruta_id === r.id).map(p => p.numero_factura || p.numero_so).filter(Boolean);
  return `<div class="pp md"><div class="band" style="background:${col};${txt}"><div><div class="big">${esc(c.v.placa || '—')}</div>Manifiesto por camión · ${esc(MD.fecha)} · ${esc(c.v.nombre || '')}</div><div style="text-align:right"><div class="big">${mdN(K.total)}</div>${K.filas.length} SKUs · ${K.facturas} facturas · ${c.rutas.length} ${varios ? 'viajes' : 'viaje'}</div></div>
   <div class="meta"><b>Conductor</b><span>${esc(mdConductores(c) || '—')}</span><b>Ayudante</b><span>${esc(mdAyudantes(c) || '—')}</span>
   <b>Rutas</b><span style="grid-column:2/-1">${c.rutas.map(r => `${esc(r.codigo)} ${esc(r.color_nombre || zona(r.zona_codigo).nombre || '')} (${facsRuta(r).length} fact.)`).join(' · ')}</span></div>
   <table>${mdColgroup([...(U ? [6] : []), 15, 15, null, ...(varios ? c.rutas.map(() => Math.min(8, 30 / c.rutas.length)) : []), 8, 7])}<thead><tr>${U ? '<th>Ubic.</th>' : ''}<th>SKU</th><th>EAN-13</th><th>Artículo</th>${varios ? c.rutas.map(r => `<th class="n">${esc(r.codigo)}</th>`).join('') : ''}<th class="n">Total</th><th>Sacado</th></tr></thead>
   <tbody>${K.filas.map(x => `<tr>${U ? `<td>${esc(x.a.ubicacion || '')}</td>` : ''}<td class="nw">${esc(x.sku)}</td><td class="nw">${esc(x.a.codigo_barras || '')}</td><td>${esc(x.a.nombre || '')}</td>${varios ? c.rutas.map(r => `<td class="n">${x.por[r.id] ? mdN(x.por[r.id]) : ''}</td>`).join('') : ''}<td class="n"><b>${mdN(x.total)}</b></td><td class="ck"><span class="chk"></span></td></tr>`).join('')}</tbody>
   <tfoot><tr><td colspan="${U ? 4 : 3}">Total</td>${varios ? c.rutas.map(r => `<td class="n">${mdN(K.porCol[r.id] || 0)}</td>`).join('') : ''}<td class="n">${mdN(K.total)}</td><td></td></tr></tfoot></table>
   <div class="facs"><b>Facturas:</b> ${c.rutas.map(r => `${varios ? esc(r.codigo) + ': ' : ''}${facsRuta(r).map(esc).join(', ')}`).join(' · ')}</div>
   <div class="firmas"><div>Preparó (bodega)</div><div>Conductor</div><div>Verificador</div></div></div>`;
}
function mdImprimir(cams, conTotal) {
  cams = (cams || []).filter(Boolean); if (!cams.length) return toast('Marca al menos un camión');
  mdPrint((conTotal ? mdHtmlTotal(cams) : '') + cams.map(mdHtmlCamion).join(''));
  DB.audit('manifiestos', 'impresion', `Manifiesto del día ${MD.fecha}: ${conTotal ? 'total + ' : ''}${cams.map(c => c.v.placa).join(', ')}`, ACTOR, false);
}
// ===================== DETALLE POR CLIENTE Y FACTURA (impresión) =====================
/* Filas de entrega de una ruta, agrupadas por cliente en orden de entrega (igual que la pantalla «Detalle por cliente y factura»). */
function mdDetalleFilas(r) {
  const stops = S.paradas.filter(p => p.ruta_id === r.id && p.tipo === 'entrega').sort((a, b) => a.secuencia - b.secuencia); const byC = {};
  stops.forEach(s => { const p = S.pedidos.find(x => x.id === s.pedido_id); if (!p) return; const c = cli(s.cliente_id) || {}; const k = c.id || s.cliente_id;
    const o = byC[k] = byC[k] || { c, seq: s.secuencia, eta: s.eta, dir: (dst(p).direccion || c.direccion || ''), facs: [], cant: 0, valor: 0 };
    o.facs.push({ n: p.numero_factura || p.numero_so, v: +p.valor || 0 }); o.cant += +p.cajas || 0; o.valor += +p.valor || 0; if (s.secuencia < o.seq) { o.seq = s.secuencia; o.eta = s.eta; } });
  return Object.values(byC).sort((a, b) => a.seq - b.seq);
}
function mdHtmlDetalleTabla(r) {
  const det = mdDetalleFilas(r); const tot = det.reduce((t, d) => ({ cant: t.cant + d.cant, valor: t.valor + d.valor, f: t.f + d.facs.length }), { cant: 0, valor: 0, f: 0 });
  return `<table>${mdColgroup([5, 5, 17, null, 13, 6, 8, 11, 13])}<thead><tr><th class="n">Carg.</th><th class="n">Entr.</th><th>Cliente</th><th>Dirección de entrega</th><th>Factura(s)</th><th class="n">Cant.</th><th class="n">Valor B/.</th><th>Observaciones</th><th>Recibido</th></tr></thead>
   <tbody>${det.map((d, i) => `<tr><td class="n">${det.length - i}</td><td class="n"><b>${i + 1}</b>${d.eta ? `<br><span style="font-size:8pt">${esc(d.eta)}</span>` : ''}</td><td><b>${esc(d.c.nombre || '')}</b>${d.c.telefono ? `<br><span style="font-size:8.5pt">${esc(d.c.telefono)}</span>` : ''}</td><td style="font-size:9pt">${esc(String(d.dir).slice(0, 160))}</td><td class="nw">${d.facs.map(f => `${esc(f.n)}${d.facs.length > 1 ? ` <span style="font-size:8pt">(${fmt(f.v)})</span>` : ''}`).join('<br>')}</td><td class="n">${mdN(d.cant)}</td><td class="n">${fmt(d.valor)}</td><td style="font-size:9pt">${d.facs.length > 1 ? d.facs.length + ' facturas · ' : ''}${d.c.ventana_inicio ? 'ventana ' + esc(d.c.ventana_inicio) + '–' + esc(d.c.ventana_fin) : ''}</td><td></td></tr>`).join('') || '<tr><td colspan="9">Sin entregas.</td></tr>'}</tbody>
   <tfoot><tr><td colspan="4">Total · ${det.length} clientes · ${tot.f} facturas</td><td></td><td class="n">${mdN(tot.cant)}</td><td class="n">${fmt(tot.valor)}</td><td colspan="2"></td></tr></tfoot></table>`;
}
/* Una hoja por camión (todos sus viajes de la fecha) o por ruta suelta. */
function mdHtmlDetalle(rutas, titulo, sub) {
  const r0 = rutas[0]; const v = veh(r0.vehiculo_id) || {}; const varios = rutas.length > 1; const col = varios ? '#0F172A' : rutaColor(r0); const txt = !varios && claro(col) ? 'color:#000' : '';
  const nf = rutas.reduce((t, r) => t + S.pedidos.filter(p => p.ruta_id === r.id).length, 0);
  return `<div class="pp md"><div class="band" style="background:${col};${txt}"><div><div class="big">${esc(titulo)}</div>${esc(sub)}</div><div style="text-align:right"><div class="big">${nf}</div>facturas · cargar en orden inverso</div></div>
   <div class="meta"><b>Camión</b><span>${esc(v.placa || '—')} ${esc(v.nombre || '')}</span><b>Conductor</b><span>${esc([...new Set(rutas.map(r => r.conductor).filter(Boolean))].join(', ') || '—')}${rutas.some(r => r.ayudante) ? ' · ayudante ' + esc([...new Set(rutas.map(r => r.ayudante).filter(Boolean))].join(', ')) : ''}</span></div>
   ${rutas.map(r => `${varios ? `<h3 style="margin:12px 0 2px">${esc(r.codigo)} · ${esc(r.color_nombre || zona(r.zona_codigo).nombre || '')}</h3>` : ''}${mdHtmlDetalleTabla(r)}`).join('')}
   <div class="firmas"><div>Despachó (bodega)</div><div>Conductor</div><div>Hora de salida</div></div></div>`;
}
function mdImprimirDetalleRuta() {
  const r = S.rutas.find(x => x.id === $('m-ruta').value); if (!r || !S.manifiestos.some(m => m.ruta_id === r.id)) return toast('Elige una ruta publicada');
  mdPrint(mdHtmlDetalle([r], `Entregas ${r.codigo}`, `Detalle por cliente y factura · ${r.fecha || ''} · ${zona(r.zona_codigo).nombre || ''}`));
  DB.audit('manifiestos', 'impresion', `Detalle por cliente y factura: ${r.codigo}`, ACTOR, false, r.id);
}
function mdImprimirDetalleCamiones() {
  const cams = mdMarcados(); if (!cams.length) return toast('Marca al menos un camión');
  mdPrint(cams.map(c => mdHtmlDetalle(c.rutas, c.v.placa || '—', `Detalle por cliente y factura · ${MD.fecha} · ${c.rutas.length} ${c.rutas.length > 1 ? 'viajes' : 'viaje'}`)).join(''));
  DB.audit('manifiestos', 'impresion', `Detalle por cliente y factura ${MD.fecha}: ${cams.map(c => c.v.placa).join(', ')}`, ACTOR, false);
}
$('md-print-det').onclick = mdImprimirDetalleCamiones;
// ===================== MANIFIESTO DE UNA FACTURA SUELTA (20-nov) =====================
/* Para la factura que se anexa tarde a una ruta: se cuenta aparte sin reimprimir el manifiesto del camión. */
function mdHtmlFactura(p) {
  const r = S.rutas.find(x => x.id === p.ruta_id) || {}; const v = veh(r.vehiculo_id) || {}; const c = cli(p.cliente_id) || {}; const d = dst(p);
  const col = r.id ? rutaColor(r) : '#0F172A'; const txt = claro(col) ? 'color:#000' : '';
  const ls = S.lineas.filter(l => l.pedido_id === p.id).map(l => ({ sku: mdSku(l.sku), q: +l.cantidad_cajas || 0, a: S.articulos.find(a => mdSku(a.sku) === mdSku(l.sku)) || {} }))
    .sort((x, y) => (x.a.ubicacion || 'ZZZ').localeCompare(y.a.ubicacion || 'ZZZ') || x.sku.localeCompare(y.sku));
  const tot = ls.reduce((s, x) => s + x.q, 0); const U = ls.some(x => x.a.ubicacion); const seq = (S.paradas.find(s => s.pedido_id === p.id) || {}).secuencia;
  return `<div class="pp md"><div class="band" style="background:${col};${txt}"><div><div class="big">${esc(p.numero_factura || p.numero_so || '')}</div>Manifiesto de factura · ${esc(r.codigo || 'sin ruta')} ${esc(r.color_nombre || '')} · ${esc(r.fecha || MD.fecha || '')}</div><div style="text-align:right"><div class="big">${mdN(tot)}</div>${ls.length} SKUs · camión ${esc(v.placa || '—')}</div></div>
   <div class="meta"><b>Cliente</b><span>${esc(c.nombre || '')} ${c.codigo ? '(' + esc(c.codigo) + ')' : ''}</span><b>Orden</b><span>${esc(p.numero_so || '')}</span><b>Entrega</b><span style="grid-column:2/-1">${esc(String(d.direccion || c.direccion || '').slice(0, 200))}${seq ? ` · parada ${seq}` : ''}</span>
   <b>Conductor</b><span>${esc(r.conductor || '—')}${r.ayudante ? ' · ayudante ' + esc(r.ayudante) : ''}</span><b>Valor</b><span>B/. ${fmt(p.valor)}</span></div>
   <table>${mdColgroup([...(U ? [7] : []), 15, 15, null, 9, 8])}<thead><tr>${U ? '<th>Ubic.</th>' : ''}<th>SKU</th><th>EAN-13</th><th>Artículo</th><th class="n">Cantidad</th><th>Sacado</th></tr></thead>
   <tbody>${ls.map(x => `<tr>${U ? `<td>${esc(x.a.ubicacion || '')}</td>` : ''}<td class="nw">${esc(x.sku)}</td><td class="nw">${esc(x.a.codigo_barras || '')}</td><td>${esc(x.a.nombre || '')}</td><td class="n"><b>${mdN(x.q)}</b></td><td class="ck"><span class="chk"></span></td></tr>`).join('') || '<tr><td colspan="6">La factura no tiene líneas sincronizadas.</td></tr>'}</tbody>
   <tfoot><tr><td colspan="${U ? 4 : 3}">Total</td><td class="n">${mdN(tot)}</td><td></td></tr></tfoot></table>
   <div class="facs"><b>Nota:</b> factura contada aparte; no aparece en el manifiesto del camión impreso antes de anexarla.</div>
   <div class="firmas"><div>Preparó (bodega)</div><div>Conductor</div><div>Verificador</div></div></div>`;
}
function mdElegirFactura() {
  const rids = new Set(mdRutas(MD.fecha).map(r => r.id)); const P = S.pedidos.filter(p => rids.has(p.ruta_id));
  if (!P.length) return toast('No hay facturas en rutas de esta fecha');
  const txt = p => { const r = S.rutas.find(x => x.id === p.ruta_id) || {}; const c = cli(p.cliente_id) || {}; return `${p.numero_factura || p.numero_so} · ${c.nombre || ''} · ${r.codigo || ''} ${(veh(r.vehiculo_id) || {}).placa || ''}`; };
  const orden = P.slice().sort((a, b) => (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || ''));
  modal(`<h2>Imprimir el manifiesto de una factura</h2><p class="mini" style="margin-top:0">Para la factura que se anexó tarde a una ruta: se imprime y se cuenta aparte, sin reimprimir el manifiesto del camión.</p>
    <label class="f">Buscar<input id="mdf-q" placeholder="Factura, orden, cliente, ruta o placa" autocomplete="off"></label>
    <label class="f" style="margin-top:8px">Factura<select id="mdf-sel" size="8" style="width:100%"></select></label><div class="form-err" id="mdf-err" hidden></div>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn sec" onclick="closeModal()">Cancelar</button><button class="btn" id="mdf-ok">Imprimir factura</button></div>`);
  const pintar = () => { const q = $('mdf-q').value.trim().toLowerCase(); const L = orden.filter(p => !q || txt(p).toLowerCase().includes(q) || String(p.numero_so || '').toLowerCase().includes(q));
    $('mdf-sel').innerHTML = L.slice(0, 300).map(p => `<option value="${p.id}">${esc(txt(p))}</option>`).join(''); if (L.length) $('mdf-sel').selectedIndex = 0; };
  $('mdf-q').oninput = pintar; pintar(); $('mdf-q').focus();
  const ir = () => { const p = S.pedidos.find(x => x.id === $('mdf-sel').value); if (!p) return formError('mdf-err', 'Elige la factura.', 'mdf-sel'); closeModal(); mdPrint(mdHtmlFactura(p)); DB.audit('manifiestos', 'impresion', `Manifiesto de factura ${p.numero_factura || p.numero_so} (${(S.rutas.find(x => x.id === p.ruta_id) || {}).codigo || ''})`, ACTOR, false, p.id); };
  $('mdf-ok').onclick = ir; $('mdf-sel').ondblclick = ir;
}
$('md-print-fac').onclick = mdElegirFactura;
$('b-print-det').onclick = mdImprimirDetalleRuta;
$('md-fecha').onchange = e => { MD.fecha = e.target.value; MD.excl.clear(); renderManifDia(); };
$('md-print-total').onclick = () => { const c = mdMarcados(); if (!c.length) return toast('Marca al menos un camión'); mdPrint(mdHtmlTotal(c)); DB.audit('manifiestos', 'impresion', `Manifiesto total ${MD.fecha}: ${c.map(x => x.v.placa).join(', ')}`, ACTOR, false); };
$('md-print-cam').onclick = () => mdImprimir(mdMarcados(), false);
$('md-print-todo').onclick = () => mdImprimir(mdMarcados(), true);
renderManifDia();
