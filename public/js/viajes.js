/* DGP · Viajes por conductor (20-nov-2026): registro de cada viaje (ruta) que hizo cada conductor y todo lo que pasó en él.
   Se consulta a la base por rango de fechas (no depende de la ventana de 3 días que carga la torre):
   ruta, camión, conductor/ayudante, horarios plan/real, km, entregas por resultado, facturas y valor, incidencias, combustible,
   peajes, costo y la bitácora de eventos de la app del conductor. Exporta a CSV. */
const VJ = { desde: '', hasta: '', conductor: '', datos: null, abierto: null };
const vjFecha = d => d ? new Date(d).toLocaleString('es-PA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const vjHora = d => d ? new Date(d).toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit' }) : '—';
const vjDur = (a, b) => { if (!a || !b) return '—'; const m = Math.round((new Date(b) - new Date(a)) / 60000); return m < 0 ? '—' : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; };
const VJ_EST = { atendida: 'Entregada', parcial: 'Parcial', no_entregada: 'No entregada', pendiente: 'Pendiente', en_sitio: 'En sitio' };
const VJ_EV = { area_cargue: 'Mercancía en área de cargue', llamado_verificador: 'Llamó al verificador', salida: 'Salida de bodega', checkin: 'Llegada al cliente', entrega: 'Entrega', demora: 'Demora', incidente: 'Incidente', combustible: 'Combustible', llegada: 'Regreso a bodega' };

async function vjCargar() {
  const desde = VJ.desde, hasta = VJ.hasta;
  let rutas = await DB.all('rutas', VJ.conductor ? { conductor: VJ.conductor } : null, 'fecha', { gte: { fecha: desde } });
  rutas = rutas.filter(r => r.estado !== 'simulada' && (!hasta || r.fecha <= hasta) && (VJ.conductor || r.conductor));
  const ids = rutas.map(r => r.id);
  const [paradas, incid, abast, peajes, costos, eventos, paquetes] = await Promise.all(['paradas', 'incidencias', 'abastecimientos', 'peajes', 'costos_ruta', 'eventos', 'paquetes'].map(t => porIds(t, 'ruta_id', ids).catch(() => [])));
  const pids = [...new Set(paradas.map(p => p.pedido_id).filter(Boolean))]; const pedidos = await porIds('pedidos', 'id', pids).catch(() => []);
  const por = (arr, r) => arr.filter(x => x.ruta_id === r.id);
  VJ.datos = rutas.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || (b.codigo || '').localeCompare(a.codigo || '')).map(r => {
    const ps = por(paradas, r).filter(p => p.tipo === 'entrega').sort((a, b) => a.secuencia - b.secuencia);
    const cuenta = e => ps.filter(p => p.estado === e).length;
    const ab = por(abast, r), pe = por(peajes, r), co = por(costos, r)[0] || null, inc = por(incid, r), ev = por(eventos, r).sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    return { r, v: veh(r.vehiculo_id) || {}, ps, ent: { total: ps.length, ok: cuenta('atendida'), parcial: cuenta('parcial'), no: cuenta('no_entregada'), pend: ps.length - cuenta('atendida') - cuenta('parcial') - cuenta('no_entregada') },
      inc, ab, pe, co, ev, paq: por(paquetes, r), ped: p => pedidos.find(x => x.id === p.pedido_id) || {},
      litros: ab.reduce((s, x) => s + (+x.litros || 0), 0), combustible: ab.reduce((s, x) => s + (+x.costo || 0), 0), peaje: pe.reduce((s, x) => s + (+(x.monto_real ?? x.monto_estimado) || 0), 0) };
  });
}
function vjConductores() { return [...new Set([...S.personas.filter(p => p.rol === 'conductor').map(p => p.nombre), ...S.rutas.map(r => r.conductor).filter(Boolean)])].sort((a, b) => a.localeCompare(b)); }

async function renderViajes(recargar) {
  const box = $('vj-body'); if (!box) return;
  if (!VJ.desde) { VJ.hasta = hoy(); VJ.desde = diasAtras(30); }
  $('vj-filtros').innerHTML = `<label class="f">Conductor<select id="vj-cond"><option value="">Todos los conductores</option>${vjConductores().map(n => `<option ${n === VJ.conductor ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
    <label class="f">Desde<input type="date" id="vj-desde" value="${VJ.desde}"></label><label class="f">Hasta<input type="date" id="vj-hasta" value="${VJ.hasta}"></label>
    <button class="btn sec" id="vj-csv">Exportar CSV</button><button class="btn sec" id="vj-print">Imprimir</button>`;
  const re = () => { VJ.abierto = null; renderViajes(true); };
  $('vj-cond').onchange = e => { VJ.conductor = e.target.value; re(); }; $('vj-desde').onchange = e => { VJ.desde = e.target.value; re(); }; $('vj-hasta').onchange = e => { VJ.hasta = e.target.value; re(); };
  $('vj-csv').onclick = vjCSV; $('vj-print').onclick = vjImprimir;
  if (recargar || !VJ.datos) { box.innerHTML = '<div class="empty">Cargando viajes…</div>'; try { await vjCargar(); } catch (e) { box.innerHTML = `<div class="empty">No se pudieron cargar los viajes: ${esc(e.message || e)}</div>`; return; } }
  const D = VJ.datos;
  if (!D.length) { box.innerHTML = `<div class="empty">Sin viajes ${VJ.conductor ? 'de ' + esc(VJ.conductor) + ' ' : ''}entre ${VJ.desde} y ${VJ.hasta}. Un viaje cuenta desde que la ruta se publica con conductor asignado.</div>`; $('vj-kpis').innerHTML = ''; return; }
  const sum = f => D.reduce((s, x) => s + f(x), 0);
  $('vj-kpis').innerHTML = [['Viajes', D.length, `${new Set(D.map(x => x.r.conductor)).size} conductor(es)`], ['Entregas', `${sum(x => x.ent.ok)} / ${sum(x => x.ent.total)}`, `${sum(x => x.ent.parcial)} parciales · ${sum(x => x.ent.no)} no entregadas`], ['Incidencias', sum(x => x.inc.length), `${sum(x => x.inc.filter(i => i.estado !== 'cerrada').length)} abiertas`], ['Km recorridos', Math.round(sum(x => +x.r.km_real || 0)).toLocaleString('es-PA'), `plan ${Math.round(sum(x => +x.r.km_plan || 0)).toLocaleString('es-PA')} km`]]
    .map(k => `<div class="tile"><div class="l">${k[0]}</div><div class="v" style="font-size:22px">${k[1]}</div><div class="s">${esc(k[2])}</div></div>`).join('');
  box.innerHTML = `<div class="tw"><table><thead><tr><th>Fecha</th><th>Conductor</th><th>Ruta</th><th>Camión</th><th>Estado</th><th>Salida → regreso</th><th class="num">Km</th><th class="num">Entregas</th><th class="num">Valor B/.</th><th class="num">Incid.</th><th class="num">Combust./peajes B/.</th><th></th></tr></thead><tbody>
    ${D.map((x, i) => `<tr${VJ.abierto === i ? ' style="background:var(--surface2)"' : ''}><td class="code" style="white-space:nowrap">${esc(x.r.fecha || '')}</td><td><b>${esc(x.r.conductor || '—')}</b>${x.r.ayudante ? `<br><span class="mini">+ ${esc(x.r.ayudante)}</span>` : ''}</td>
      <td style="white-space:nowrap"><span class="swatch" style="background:${esc(x.r.color || x.v.color || '#64748B')}"></span><b>${esc(x.r.codigo)}</b><br><span class="mini">${esc(x.r.color_nombre || zona(x.r.zona_codigo).nombre || '')}</span></td>
      <td class="code" style="white-space:nowrap">${esc(x.v.placa || '')}<br><span class="mini">${esc(x.v.nombre || '')}</span></td><td>${rpill(x.r.estado)}</td>
      <td class="mini">${vjHora(x.r.salida_at)} → ${vjHora(x.r.llegada_at)}<br>${vjDur(x.r.salida_at, x.r.llegada_at)}</td>
      <td class="num">${x.r.km_real != null ? f1(x.r.km_real) : '—'}<br><span class="mini">plan ${f1(x.r.km_plan)}</span></td>
      <td class="num"><b>${x.ent.ok}</b>/${x.ent.total}${x.ent.parcial || x.ent.no ? `<br><span class="mini">${x.ent.parcial} parc. · ${x.ent.no} no</span>` : ''}</td>
      <td class="num">${fmt(x.r.valor)}</td><td class="num">${x.inc.length ? `<b style="color:var(--crit)">${x.inc.length}</b>` : '0'}</td>
      <td class="num">${fmt(x.combustible)} / ${fmt(x.peaje)}</td><td><button class="btn sec xs" data-vj="${i}">${VJ.abierto === i ? 'Cerrar' : 'Ver todo'}</button></td></tr>
      ${VJ.abierto === i ? `<tr><td colspan="12" style="background:var(--surface2)">${vjDetalle(x)}</td></tr>` : ''}`).join('')}</tbody></table></div>`;
  document.querySelectorAll('[data-vj]').forEach(b => b.onclick = () => { const i = +b.dataset.vj; VJ.abierto = VJ.abierto === i ? null : i; renderViajes(false); });
}
function vjDetalle(x) {
  const r = x.r;
  const meta = [['Conductor', r.conductor || '—'], ['Ayudante', r.ayudante || '—'], ['Camión', `${x.v.placa || ''} ${x.v.nombre || ''}`], ['Salida plan / real', `${r.hora_salida || '—'} / ${vjFecha(r.salida_at)}`], ['Regreso previsto / real', `${r.hora_fin_prevista || '—'} / ${vjFecha(r.llegada_at)}`],
    ['Odómetro', r.odometro_salida != null ? `${r.odometro_salida} → ${r.odometro_llegada ?? '—'} km` : '—'], ['Paquetes', `${x.paq.length} (${x.paq.filter(q => q.estado === 'entregado_gd' || q.estado === 'en_bodega' || q.estado === 'registrado').length} registrados)`],
    ['Pallets', r.pallets_salida != null ? `salida ${r.pallets_salida} · retorno ${r.pallets_retorno ?? '—'}` : '—'], ['Combustible', x.ab.length ? `${f1(x.litros)} L · B/. ${fmt(x.combustible)}` : '—'], ['Peajes', x.pe.length ? `${x.pe.length} · B/. ${fmt(x.peaje)}` : '—'],
    ['Costo del viaje', x.co ? `B/. ${fmt(x.co.costo_total)} · ${fmt(x.co.costo_por_entrega)} por entrega${x.co.datos_completos === false ? ' (datos incompletos)' : ''}` : 'sin conciliar']];
  return `<div style="padding:6px 4px">
    <div class="kv" style="grid-template-columns:repeat(4,auto 1fr);gap:4px 12px;margin-bottom:10px">${meta.map(m => `<b>${m[0]}</b><span>${esc(m[1])}</span>`).join('')}</div>
    <h3 style="margin:8px 0 4px">Entregas</h3>
    <table><thead><tr><th class="num">#</th><th>Cliente</th><th>Factura</th><th>ETA</th><th>Llegó · salió</th><th>Resultado</th><th>Recibió</th><th>Notas</th></tr></thead><tbody>
    ${x.ps.map(p => { const pd = x.ped(p); const c = cli(p.cliente_id) || {}; return `<tr><td class="num">${p.secuencia}</td><td>${esc(c.nombre || '')}</td><td class="code">${esc(pd.numero_factura || pd.numero_so || '')}</td><td class="code">${esc(p.eta || '')}</td><td class="mini">${vjHora(p.checkin_at)} · ${vjHora(p.checkout_at)}${p.distancia_checkin_m != null ? `<br>check-in a ${p.distancia_checkin_m} m` : ''}</td><td>${esc(VJ_EST[p.estado] || p.estado || '')}${p.resultado ? `<br><span class="mini">${esc(p.resultado)}</span>` : ''}</td><td class="mini">${esc(p.receptor || '')}${p.firma ? ' · firma' : ''}${(p.fotos || []).length || p.foto ? ' · fotos' : ''}</td><td class="mini">${esc(p.notas || '')}</td></tr>`; }).join('') || '<tr><td colspan="8" class="note">Sin entregas.</td></tr>'}</tbody></table>
    ${x.inc.length ? `<h3 style="margin:12px 0 4px">Incidencias</h3><table><thead><tr><th>Hora</th><th>Tipo</th><th>Descripción</th><th class="num">Demora</th><th>Estado</th></tr></thead><tbody>${x.inc.map(i => `<tr><td class="mini">${vjFecha(i.created_at)}</td><td>${esc(i.tipo || '')}</td><td>${esc(i.descripcion || '')}${i.justificacion ? `<br><span class="mini">Justificación: ${esc(i.justificacion)}</span>` : ''}</td><td class="num">${i.demora_min ? i.demora_min + ' min' : ''}</td><td>${esc(i.estado || '')}</td></tr>`).join('')}</tbody></table>` : ''}
    <h3 style="margin:12px 0 4px">Bitácora del viaje</h3>
    <div class="log" style="max-height:260px;overflow:auto">${x.ev.map(e => `<div><span>${vjFecha(e.created_at)}</span> <b>${esc(VJ_EV[e.tipo] || e.tipo)}</b> ${esc((e.detalle && (e.detalle.texto || e.detalle.motivo)) || '')}${e.offline ? ' <span class="mini">(sin conexión)</span>' : ''}</div>`).join('') || '<div class="note">Sin eventos registrados por la app del conductor.</div>'}</div></div>`;
}
function vjFilasCSV() {
  return (VJ.datos || []).map(x => ({ fecha: x.r.fecha, conductor: x.r.conductor || '', ayudante: x.r.ayudante || '', ruta: x.r.codigo, ruta_zoho: x.r.color_nombre || x.r.zona_codigo || '', camion: x.v.placa || '', camion_nombre: x.v.nombre || '', estado: x.r.estado,
    salida: x.r.salida_at || '', regreso: x.r.llegada_at || '', duracion: vjDur(x.r.salida_at, x.r.llegada_at), km_plan: x.r.km_plan ?? '', km_real: x.r.km_real ?? '', entregas: x.ent.total, entregadas: x.ent.ok, parciales: x.ent.parcial, no_entregadas: x.ent.no,
    facturas: x.paq.length, valor: x.r.valor, incidencias: x.inc.length, litros: x.litros, combustible: x.combustible, peajes: x.peaje, costo_total: x.co ? x.co.costo_total : '' }));
}
function vjCSV() { if (!(VJ.datos || []).length) return toast('No hay viajes para exportar'); descargarCSV(`viajes_${VJ.conductor ? VJ.conductor.replace(/\s+/g, '_') + '_' : ''}${VJ.desde}_${VJ.hasta}.csv`, vjFilasCSV()); }
function vjImprimir() {
  const D = VJ.datos || []; if (!D.length) return toast('No hay viajes para imprimir');
  const html = `<div class="pp md"><div class="band" style="background:#0F172A"><div><div class="big">Viajes ${VJ.conductor ? '· ' + esc(VJ.conductor) : 'por conductor'}</div>${esc(VJ.desde)} a ${esc(VJ.hasta)}</div><div style="text-align:right"><div class="big">${D.length}</div>viajes</div></div>
   <table>${mdColgroup([8, 14, 9, 9, null, 10, 6, 8, 8, 5])}<thead><tr><th>Fecha</th><th>Conductor</th><th>Ruta</th><th>Camión</th><th>Salida → regreso</th><th>Estado</th><th class="n">Km</th><th class="n">Entregas</th><th class="n">Valor</th><th class="n">Inc.</th></tr></thead>
   <tbody>${D.map(x => `<tr><td>${esc(x.r.fecha)}</td><td>${esc(x.r.conductor || '')}</td><td>${esc(x.r.codigo)}</td><td>${esc(x.v.placa || '')}</td><td>${vjFecha(x.r.salida_at)} → ${vjHora(x.r.llegada_at)} (${vjDur(x.r.salida_at, x.r.llegada_at)})</td><td>${esc(x.r.estado)}</td><td class="n">${x.r.km_real != null ? f1(x.r.km_real) : '—'}</td><td class="n">${x.ent.ok}/${x.ent.total}</td><td class="n">${fmt(x.r.valor)}</td><td class="n">${x.inc.length}</td></tr>`).join('')}</tbody></table></div>`;
  if (typeof mdPrint === 'function') mdPrint(html); else imprimir(html);
}
