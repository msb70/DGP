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
function mdHtmlTotal(cams) {
  const T = mdConsolidar(cams.flatMap(c => c.rutas), r => r.vehiculo_id); const n = cams.length;
  const wc = Math.min(8, 42 / Math.max(n, 1)); // columna por camión
  return `<div class="pp md tot"><div class="band" style="background:#0F172A"><div><div class="big">Manifiesto total</div>${esc(MD.fecha)} · ${n} camión(es)</div><div style="text-align:right"><div class="big">${mdN(T.total)}</div>${T.filas.length} SKUs · ${T.facturas} facturas</div></div>
   <div class="meta"><b>Camiones</b><span style="grid-column:2/-1">${cams.map(c => `${esc(c.v.placa || '')} (${c.rutas.map(r => esc(r.codigo)).join(', ')})`).join(' · ')}</span></div>
   <table>${mdColgroup([5, 13, null, ...cams.map(() => wc), 7, 6.5])}<thead><tr><th>Ubic.</th><th>SKU</th><th>Artículo</th>${cams.map(c => `<th class="n pl">${esc(c.v.placa || '')}</th>`).join('')}<th class="n">Total</th><th>Sacado</th></tr></thead>
   <tbody>${T.filas.map(x => `<tr><td>${esc(x.a.ubicacion || '')}</td><td class="nw">${esc(x.sku)}</td><td>${esc(x.a.nombre || '')}</td>${cams.map(c => `<td class="n">${x.por[c.id] ? mdN(x.por[c.id]) : ''}</td>`).join('')}<td class="n"><b>${mdN(x.total)}</b></td><td class="ck"><span class="chk"></span></td></tr>`).join('')}</tbody>
   <tfoot><tr><td colspan="3">Total</td>${cams.map(c => `<td class="n">${mdN(T.porCol[c.id] || 0)}</td>`).join('')}<td class="n">${mdN(T.total)}</td><td></td></tr></tfoot></table>
   <div class="firmas"><div>Preparó (bodega)</div><div>Jefe de bodega</div><div>Hora</div></div></div>`;
}
function mdHtmlCamion(c) {
  const K = mdConsolidar(c.rutas, r => r.id); const varios = c.rutas.length > 1;
  const col = varios ? '#0F172A' : rutaColor(c.rutas[0]); const txt = !varios && claro(col) ? 'color:#000' : '';
  const facsRuta = r => S.pedidos.filter(p => p.ruta_id === r.id).map(p => p.numero_factura || p.numero_so).filter(Boolean);
  return `<div class="pp md"><div class="band" style="background:${col};${txt}"><div><div class="big">${esc(c.v.placa || '—')}</div>Manifiesto por camión · ${esc(MD.fecha)} · ${esc(c.v.nombre || '')}</div><div style="text-align:right"><div class="big">${mdN(K.total)}</div>${K.filas.length} SKUs · ${K.facturas} facturas · ${c.rutas.length} ${varios ? 'viajes' : 'viaje'}</div></div>
   <div class="meta"><b>Conductor</b><span>${esc(mdConductores(c) || '—')}</span><b>Ayudante</b><span>${esc(mdAyudantes(c) || '—')}</span>
   <b>Rutas</b><span style="grid-column:2/-1">${c.rutas.map(r => `${esc(r.codigo)} ${esc(r.color_nombre || zona(r.zona_codigo).nombre || '')} (${facsRuta(r).length} fact.)`).join(' · ')}</span></div>
   <table>${mdColgroup([6, 15, 15, null, ...(varios ? c.rutas.map(() => Math.min(8, 30 / c.rutas.length)) : []), 8, 7])}<thead><tr><th>Ubic.</th><th>SKU</th><th>EAN-13</th><th>Artículo</th>${varios ? c.rutas.map(r => `<th class="n">${esc(r.codigo)}</th>`).join('') : ''}<th class="n">Total</th><th>Sacado</th></tr></thead>
   <tbody>${K.filas.map(x => `<tr><td>${esc(x.a.ubicacion || '')}</td><td class="nw">${esc(x.sku)}</td><td class="nw">${esc(x.a.codigo_barras || '')}</td><td>${esc(x.a.nombre || '')}</td>${varios ? c.rutas.map(r => `<td class="n">${x.por[r.id] ? mdN(x.por[r.id]) : ''}</td>`).join('') : ''}<td class="n"><b>${mdN(x.total)}</b></td><td class="ck"><span class="chk"></span></td></tr>`).join('')}</tbody>
   <tfoot><tr><td colspan="4">Total</td>${varios ? c.rutas.map(r => `<td class="n">${mdN(K.porCol[r.id] || 0)}</td>`).join('') : ''}<td class="n">${mdN(K.total)}</td><td></td></tr></tfoot></table>
   <div class="facs"><b>Facturas:</b> ${c.rutas.map(r => `${varios ? esc(r.codigo) + ': ' : ''}${facsRuta(r).map(esc).join(', ')}`).join(' · ')}</div>
   <div class="firmas"><div>Preparó (bodega)</div><div>Conductor</div><div>Verificador</div></div></div>`;
}
function mdImprimir(cams, conTotal) {
  cams = (cams || []).filter(Boolean); if (!cams.length) return toast('Marca al menos un camión');
  imprimir((conTotal ? mdHtmlTotal(cams) : '') + cams.map(mdHtmlCamion).join(''));
  DB.audit('manifiestos', 'impresion', `Manifiesto del día ${MD.fecha}: ${conTotal ? 'total + ' : ''}${cams.map(c => c.v.placa).join(', ')}`, ACTOR, false);
}
$('md-fecha').onchange = e => { MD.fecha = e.target.value; MD.excl.clear(); renderManifDia(); };
$('md-print-total').onclick = () => { const c = mdMarcados(); if (!c.length) return toast('Marca al menos un camión'); imprimir(mdHtmlTotal(c)); DB.audit('manifiestos', 'impresion', `Manifiesto total ${MD.fecha}: ${c.map(x => x.v.placa).join(', ')}`, ACTOR, false); };
$('md-print-cam').onclick = () => mdImprimir(mdMarcados(), false);
$('md-print-todo').onclick = () => mdImprimir(mdMarcados(), true);
renderManifDia();
