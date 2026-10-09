/* DGP · Programa operativo de incentivos (infografía DGP Express).
   Paneles (distribución multipunto): indicadores diarios. Camiones / Fuso (cuentas corporativas): indicadores por viaje.
   Bono semanal por equipo (conductor + ayudante) según el puntaje promedio. Metas y puntos parametrizables en reglas. */
const IN = { tab: 'dia', semana: null };
const progDe = v => (v && v.programa_incentivo) || (v && v.tipo === 'camion' ? 'camiones' : 'paneles');
const cfgProg = p => R(p === 'camiones' ? 'incentivo_camiones' : 'incentivo_paneles');
function semanaISO(f) { const d = new Date(f + 'T12:00:00'); const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const dn = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - dn); const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return `${t.getUTCFullYear()}-S${String(Math.ceil(((t - y) / 864e5 + 1) / 7)).padStart(2, '0')}`; }
const cumpleInd = (op, val, meta) => { if (val == null || val === '') return null; if (op === '<') return String(val) < String(meta); return op === '>=' ? +val >= +meta : +val <= +meta; };
const minDif = (a, b) => (new Date(b) - new Date(a)) / 6e4;
const horaLocal = t => t ? new Date(t).toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit', hour12: false }) : null;

/* Datos crudos de una ruta, desde la operación registrada */
function datosRuta(r) {
  const ent = S.paradas.filter(p => p.ruta_id === r.id && p.tipo === 'entrega'); const peds = S.pedidos.filter(p => p.ruta_id === r.id);
  const inc = S.incidencias.filter(i => i.ruta_id === r.id); const justP = new Set(inc.filter(i => i.tipo === 'devolucion' && i.justificada).map(i => i.parada_id));
  let fact = 0, entregadoV = 0, devNoJ = 0, cajasPlan = 0, cajasEnt = 0, faltCajas = 0, ejec = 0;
  for (const s of ent) {
    const p = peds.find(x => x.id === s.pedido_id); if (!p) continue; const ls = S.lineas.filter(l => l.pedido_id === p.id); fact += +p.valor; cajasPlan += +p.cajas;
    let vEnt = +p.valor, cEnt = +p.cajas;
    if (s.estado === 'parcial') { vEnt = ls.reduce((t, l) => t + (l.entregado ?? l.cantidad_cajas) * +l.precio, 0); cEnt = ls.reduce((t, l) => t + +(l.entregado ?? l.cantidad_cajas), 0); if (/faltante/i.test(s.resultado || '')) faltCajas += +p.cajas - cEnt; }
    if (s.estado === 'no_entregada') { vEnt = 0; cEnt = 0; }
    if (!['pendiente', 'en_sitio'].includes(s.estado)) ejec++;
    entregadoV += vEnt; cajasEnt += cEnt; if (!justP.has(s.id)) devNoJ += +p.valor - vEnt;
  }
  const pq = S.paquetes.filter(q => q.ruta_id === r.id); const justF = inc.some(i => i.tipo === 'faltante' && i.justificada);
  const faltVerif = justF ? 0 : pq.reduce((t, q) => t + +(q.faltante_cajas || 0), 0); faltCajas += faltVerif;
  const facturaConFaltante = !justF && pq.some(q => +q.faltante_cajas > 0 && ['atendida', 'parcial'].includes((ent.find(s => s.pedido_id === q.pedido_id) || {}).estado));
  const tol = +R('ventana_tolerancia').minutos || 15; const hechas = ent.filter(s => s.checkin_at);
  const aTiempo = hechas.filter(s => { const t = tmin(horaLocal(s.checkin_at)); const lim = s.ventana_fin ? tmin(s.ventana_fin) + tol : tmin(s.eta) + 30; return t <= lim && s.estado === 'atendida'; }).length;
  const conT = ent.filter(s => s.checkin_at && s.checkout_at); const enStd = conT.filter(s => minDif(s.checkin_at, s.checkout_at) <= (+s.duracion_min || 15) + 5).length;
  const c = S.costos.find(x => x.ruta_id === r.id); const ab = (S.abast || []).filter(a => a.ruta_id === r.id).reduce((t, a) => t + +a.costo, 0);
  const salio = !!r.salida_at; const cerrada = salio && ['cerrada', 'conciliada'].includes(r.estado); // sin salida registrada = preliminar (plan)
  return { cerrada, ejec, n: ent.length, facturacion: salio ? entregadoV : fact, clientes: new Set(ent.filter(s => salio ? ['atendida', 'parcial'].includes(s.estado) : true).map(s => s.cliente_id)).size,
    salida: horaLocal(r.salida_at), combustible: c ? +c.costo_combustible : ab ? ab : null,
    devoluciones: fact ? devNoJ / fact * 100 : 0, faltantes: cajasPlan ? faltCajas / cajasPlan * 100 : 0, faltCajas, facturaConFaltante,
    reclamos: inc.filter(i => i.tipo === 'reclamo' && !i.justificada).length,
    carga_completa: salio && ejec ? (cajasPlan ? cajasEnt / cajasPlan * 100 : null) : null, otif: hechas.length ? aTiempo / ent.length * 100 : null,
    tiempo_carga: conT.length ? enStd / conT.length * 100 : null,
    pallets: r.pallets_salida ? (+r.pallets_retorno || 0) / +r.pallets_salida * 100 * (r.pallets_buen_estado === false ? 0 : 1) : null };
}
function evaluar(r, prev) {
  const v = veh(r.vehiculo_id) || {}; const prog = progDe(v); const cfg = cfgProg(prog); const d = datosRuta(r); const man = {}; ((prev && prev.indicadores) || []).forEach(i => { if (i.manual) man[i.k] = i; });
  const ind = (cfg.indicadores || []).map(x => { const m = man[x.k]; const val = m ? m.valor : d[x.k]; const ok = cumpleInd(x.op, val, x.meta); return Object.assign({}, x, { valor: val, cumple: ok, puntos: ok ? +x.pts : 0, nd: val == null, manual: !!m, motivo: m ? m.motivo : null }); });
  let pen = 0; const fi = ind.find(i => i.k === 'faltantes'); if (prog === 'camiones' && d.facturaConFaltante && fi && fi.penalidad_factura_con_faltante) pen = +fi.penalidad_factura_con_faltante;
  const puntaje = Math.max(0, ind.reduce((t, i) => t + i.puntos, 0) + pen);
  return { prog, cfg, d, ind, pen, puntaje, anulado: !!(prev && prev.anulado), motivo_anulacion: prev ? prev.motivo_anulacion : null };
}
const bonoDe = (cfg, pts) => { const t = (cfg.tramos || []).slice().sort((a, b) => b.desde - a.desde).find(t => pts >= t.desde); return t ? +t.bono : 0; };
const fmtInd = (i) => i.nd ? 'sin dato' : i.u === 'B/.' ? 'B/. ' + fmt(i.valor) : i.u === '%' ? f1(i.valor) + ' %' : i.u === 'hora' ? i.valor : `${Math.round(i.valor * 10) / 10}`;
const metaTxt = i => `${i.op === '>=' ? '≥' : i.op === '<' ? 'antes de' : '≤'} ${i.u === 'B/.' ? 'B/. ' + fmt(i.meta) : i.meta}${i.u === '%' ? ' %' : i.u === 'B/.' || i.u === 'hora' ? '' : ' ' + i.u}`;
const rutasDia = () => S.rutas.filter(r => r.estado !== 'simulada').sort((a, b) => a.codigo.localeCompare(b.codigo));
const prevDe = r => S.incentivos.find(x => x.fecha === hoy() && x.ruta_codigo === r.codigo && !x.demo);

async function calcularDia() {
  if (!exige('incentivos')) return; const rs = rutasDia(); if (!rs.length) { toast('No hay rutas publicadas hoy'); return; }
  for (const r of rs) { const v = veh(r.vehiculo_id) || {}; const e = evaluar(r, prevDe(r)); await DB.remove('incentivos', { fecha: hoy(), ruta_codigo: r.codigo, demo: false });
    await DB.insert('incentivos', [{ fecha: hoy(), semana: semanaISO(hoy()), ruta_codigo: r.codigo, vehiculo_placa: v.placa, programa: e.prog, conductor: r.conductor, ayudante: r.ayudante, indicadores: e.ind.map(({ k, n, meta, op, u, pts, valor, cumple, puntos, nd, manual, motivo }) => ({ k, n, meta, op, u, pts, valor, cumple, puntos, nd, manual, motivo })).concat(e.pen ? [{ k: 'penalidad', n: 'Factura entregada con faltante', puntos: e.pen }] : []), puntaje: e.puntaje, anulado: e.anulado, motivo_anulacion: e.motivo_anulacion, demo: false, calculado_por: ACTOR }]); }
  await DB.audit('incentivos', 'calculo', `Incentivos del ${hoy()} calculados para ${rs.length} rutas${rs.some(r => !['cerrada', 'conciliada'].includes(r.estado)) ? ' (algunas preliminares: ruta sin cerrar)' : ''}`, ACTOR, false);
  toast('Incentivos del día guardados'); await loadAll(); render();
}
async function semanaDemo() {
  const demo = S.incentivos.filter(x => x.demo); if (demo.length) { await DB.remove('incentivos', { demo: true }); toast('Semana de demostración eliminada'); await loadAll(); render(); return; }
  const hoyD = new Date(hoy() + 'T12:00:00'); const dow = hoyD.getDay() || 7; const dias = []; for (let i = 1; i < dow && i <= 5; i++) { const d = new Date(hoyD); d.setDate(d.getDate() - (dow - i)); dias.push(d.toISOString().slice(0, 10)); }
  if (!dias.length) { const d = new Date(hoyD); for (let i = 7; i >= 3; i--) { const x = new Date(d); x.setDate(d.getDate() - i); dias.push(x.toISOString().slice(0, 10)); } }
  let sd = 7; const rnd = () => (sd = (sd * 9301 + 49297) % 233280) / 233280; const rows = [];
  S.vehiculos.filter(v => v.activo !== false).forEach((v, vi) => { const prog = progDe(v); const cfg = cfgProg(prog); const nivel = [0.95, 0.75, 0.9, 0.6, 0.85, 0.7, 0.92, 0.5][vi % 8];
    dias.forEach(f => { const ind = (cfg.indicadores || []).map(x => { const ok = rnd() < nivel; let val; if (x.u === 'hora') val = ok ? '08:4' + Math.floor(rnd() * 9) : '09:1' + Math.floor(rnd() * 9); else if (x.op === '>=') val = ok ? +x.meta * (1 + rnd() * 0.25) : +x.meta * (0.6 + rnd() * 0.35); else val = ok ? Math.max(0, +x.meta - rnd() * Math.max(+x.meta, 0) * 0.5) : (+x.meta || 0) + 0.5 + rnd() * (x.u === 'B/.' ? 20 : 2); if (x.u === 'reclamos' || x.u === 'clientes') val = Math.round(val); if (typeof val === 'number') val = Math.round(val * 100) / 100; const c = cumpleInd(x.op, val, x.meta); return { k: x.k, n: x.n, meta: x.meta, op: x.op, u: x.u, pts: x.pts, valor: val, cumple: c, puntos: c ? x.pts : 0, nd: false }; });
      rows.push({ fecha: f, semana: semanaISO(f), ruta_codigo: `DEMO-${v.placa}`, vehiculo_placa: v.placa, programa: prog, conductor: v.conductor, ayudante: v.ayudante, indicadores: ind, puntaje: ind.reduce((t, i) => t + i.puntos, 0), anulado: false, demo: true, calculado_por: 'demo' }); }); });
  await DB.insert('incentivos', rows); await DB.audit('incentivos', 'demo', `${rows.length} registros de demostración (${dias.join(', ')}) para ver el bono semanal. No son datos reales.`, ACTOR, false); toast('Semana de demostración cargada'); IN.tab = 'semana'; await loadAll(); render();
}
function renderIncentivos() {
  document.querySelectorAll('#in-tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === IN.tab)); $('in-demo').textContent = S.incentivos.some(x => x.demo) ? 'Quitar semana de demostración' : 'Cargar semana de demostración';
  const B = $('in-body');
  if (IN.tab === 'dia') {
    const rs = rutasDia(); if (!rs.length) { B.innerHTML = '<div class="empty">Sin rutas publicadas hoy. Los indicadores se calculan con la operación registrada (entregas, check-in, verificación de salida, combustible, incidencias).</div>'; return; }
    B.innerHTML = ['paneles', 'camiones'].map(prog => { const lst = rs.filter(r => progDe(veh(r.vehiculo_id)) === prog); if (!lst.length) return ''; const cfg = cfgProg(prog);
      return `<h3 style="margin:14px 0 8px">${prog === 'paneles' ? 'Paneles · distribución multipunto · medición diaria' : 'Camiones / Fuso · cuentas corporativas · medición por viaje'}</h3><div class="tw"><table><thead><tr><th>Ruta · equipo</th>${(cfg.indicadores || []).map(i => `<th class="num" title="${esc(i.n)}">${esc(i.n.split(' ')[0])}<br><span class="mini">${esc(metaTxt(i))} · ${i.pts}</span></th>`).join('')}<th class="num">Puntaje</th><th>Bono semanal hoy</th><th></th></tr></thead><tbody>${lst.map(r => { const e = evaluar(r, prevDe(r)); const sav = prevDe(r);
        return `<tr><td><span class="swatch" style="background:${r.color}"></span><b>${r.codigo}</b> ${(veh(r.vehiculo_id) || {}).placa}<br><span class="mini">${esc(r.conductor)}${r.ayudante ? ' + ' + esc(r.ayudante) : ''} · ${e.d.cerrada ? 'final' : r.salida_at ? 'preliminar: en ruta' : 'preliminar: sin salir'}${sav ? ' · guardado' : ''}</span></td>${e.ind.map(i => `<td class="num"><span class="${i.nd ? 'ind-nd' : i.cumple ? 'ind-ok' : 'ind-no'}">${esc(fmtInd(i))}</span>${i.manual ? '<span class="mini"> (manual)</span>' : ''}<br><span class="mini">${i.puntos} pts</span></td>`).join('')}<td class="num"><span class="score">${e.puntaje}</span>${e.pen ? `<br><span class="pill p-crit nodot">${e.pen} factura con faltante</span>` : ''}</td><td>${e.anulado ? `<span class="pill p-crit">Anulado</span>` : `<span class="pill ${bonoDe(e.cfg, e.puntaje) ? 'p-ok' : 'p-mut'} nodot">${bonoDe(e.cfg, e.puntaje) ? 'tramo B/. ' + bonoDe(e.cfg, e.puntaje) : 'sin bono'}</span>`}</td><td><button class="btn sec xs" data-ind="${r.id}">Detalle</button></td></tr>`; }).join('')}</tbody></table></div>`; }).join('') + `<p class="note" style="margin-top:10px">"Sin dato" no suma puntos: falta el registro en el sistema (salida, check-in, combustible o pallets). Corrige el dato en Detalle con un motivo; queda auditado. Pulsa <b>Calcular incentivos del día</b> para guardar el resultado en el histórico semanal.</p>`;
    document.querySelectorAll('[data-ind]').forEach(b => b.onclick = () => detalleInd(b.dataset.ind)); return;
  }
  if (IN.tab === 'semana') {
    const sems = [...new Set(S.incentivos.map(x => x.semana))].sort().reverse(); if (!IN.semana || !sems.includes(IN.semana)) IN.semana = sems[0];
    if (!sems.length) { B.innerHTML = '<div class="empty">Sin histórico. Calcula los incentivos del día o carga la semana de demostración.</div>'; return; }
    const rows = S.incentivos.filter(x => x.semana === IN.semana); const eq = {}; rows.forEach(x => { const k = `${x.programa}|${x.vehiculo_placa}|${x.conductor}|${x.ayudante || ''}`; (eq[k] = eq[k] || []).push(x); });
    const res = Object.entries(eq).map(([k, xs]) => { const [prog, placa, cond, ayu] = k.split('|'); const cfg = cfgProg(prog); const prom = xs.reduce((t, x) => t + +x.puntaje, 0) / xs.length; const falt = prog === 'paneles' && xs.some(x => (x.indicadores || []).some(i => i.k === 'faltantes' && !i.nd && +i.valor > 0)); const anu = xs.find(x => x.anulado); const motivo = anu ? anu.motivo_anulacion || 'anulado' : falt ? 'hubo faltantes en la semana' : ''; const bono = motivo ? 0 : bonoDe(cfg, prom); return { prog, placa, cond, ayu, xs: xs.sort((a, b) => a.fecha.localeCompare(b.fecha)), prom, bono, motivo, demo: xs.some(x => x.demo) }; }).sort((a, b) => a.prog.localeCompare(b.prog) || b.prom - a.prom);
    IN._res = res; const tot = res.reduce((t, x) => t + x.bono, 0);
    B.innerHTML = `<div class="row" style="margin-bottom:10px"><label class="f">Semana<select id="in-sem">${sems.map(s => `<option ${s === IN.semana ? 'selected' : ''}>${s}</option>`).join('')}</select></label><div class="tile" style="padding:8px 14px"><div class="l">Total bonos a pagar</div><div class="v" style="font-size:22px">B/. ${fmt(tot)}</div></div>${res.some(x => x.demo) ? '<span class="pill p-warn">Incluye datos de demostración</span>' : ''}</div>
    <div class="tw"><table><thead><tr><th>Programa</th><th>Equipo (conductor + ayudante)</th><th>Vehículo</th><th>Días / viajes</th><th class="num">Puntaje promedio</th><th class="num">Bono semanal</th><th>Observación</th></tr></thead><tbody>${res.map(x => `<tr><td>${x.prog === 'paneles' ? 'Paneles' : 'Camiones / Fuso'}</td><td><b>${esc(x.cond)}</b>${x.ayu ? ' + ' + esc(x.ayu) : ''}</td><td class="code">${esc(x.placa)}</td><td class="mini">${x.xs.map(d => `${new Date(d.fecha + 'T12:00:00').toLocaleDateString('es-PA', { weekday: 'short' })} <b>${Math.round(d.puntaje)}</b>${d.demo ? '*' : ''}`).join(' · ')}</td><td class="num"><span class="score">${f1(x.prom)}</span></td><td class="num"><b>${x.bono ? 'B/. ' + fmt(x.bono) : '—'}</b></td><td class="mini">${x.motivo ? `<span class="pill p-crit nodot">Sin bono: ${esc(x.motivo)}</span>` : x.bono ? '' : 'menos de 70 puntos'}</td></tr>`).join('')}</tbody></table></div>
    <p class="note" style="margin-top:8px">Tramos Paneles: 90–100 → B/. ${(cfgProg('paneles').tramos || [])[0]?.bono} · 80–89 → ${(cfgProg('paneles').tramos || [])[1]?.bono} · 70–79 → ${(cfgProg('paneles').tramos || [])[2]?.bono}. Camiones: ${(cfgProg('camiones').tramos || []).map(t => t.desde + '+ → B/. ' + t.bono).join(' · ')}. Bono por equipo. * = dato de demostración.</p>`;
    $('in-sem').onchange = e => { IN.semana = e.target.value; renderIncentivos(); }; return;
  }
  // metas
  B.innerHTML = ['paneles', 'camiones'].map(prog => { const cfg = cfgProg(prog); const sum = (cfg.indicadores || []).reduce((t, i) => t + +i.pts, 0); return `<div class="card flat" style="margin-bottom:12px"><div class="hd"><h3>${prog === 'paneles' ? 'Paneles · distribución multipunto' : 'Camiones / Fuso · cuentas corporativas'}</h3><span class="pill ${sum === 100 ? 'p-ok' : 'p-crit'} nodot">Total ${sum} puntos</span></div><div class="tw"><table><thead><tr><th>Indicador</th><th>Condición</th><th>Meta</th><th class="num">Puntos</th></tr></thead><tbody>${(cfg.indicadores || []).map((i, ix) => `<tr><td>${esc(i.n)}</td><td class="code">${i.op === '>=' ? '≥' : i.op === '<' ? 'antes de' : '≤'} (${esc(i.u)})</td><td><input data-meta="${prog}|${ix}" value="${esc(i.meta)}" style="width:90px" ${puede('incentivos') ? '' : 'disabled'}></td><td class="num"><input type="number" data-pts="${prog}|${ix}" value="${i.pts}" style="width:64px" ${puede('incentivos') ? '' : 'disabled'}></td></tr>`).join('')}</tbody></table></div>
    <div class="row" style="margin-top:8px"><b class="mini">Bono semanal por equipo:</b>${(cfg.tramos || []).map((t, ix) => `<label class="mini">desde <input type="number" data-td="${prog}|${ix}" value="${t.desde}" style="width:56px" ${puede('incentivos') ? '' : 'disabled'}> pts → B/. <input type="number" data-tb="${prog}|${ix}" value="${t.bono}" style="width:64px" ${puede('incentivos') ? '' : 'disabled'}></label>`).join('')}<span class="mini">Menos del último tramo: sin bono. Anula el bono: ${esc(cfg.anula_bono || '')}.</span></div></div>`; }).join('') + `<p class="note">${puede('incentivos') ? 'Cada cambio queda en la bitácora de auditoría.' : 'Solo Gerencia de operaciones, Encargado de bodega y Administración editan metas.'}</p>`;
  const save = async (el, f) => { if (!exige('incentivos')) return; const [prog, ix] = el.dataset[f].split('|'); const clave = prog === 'camiones' ? 'incentivo_camiones' : 'incentivo_paneles'; const row = S.reglasRows.find(r => r.clave === clave); const v = JSON.parse(JSON.stringify(row.valor)); let old;
    if (f === 'meta') { const i = v.indicadores[+ix]; old = i.meta; i.meta = i.u === 'hora' ? el.value : +el.value; } else if (f === 'pts') { const i = v.indicadores[+ix]; old = i.pts; i.pts = +el.value; } else if (f === 'td') { old = v.tramos[+ix].desde; v.tramos[+ix].desde = +el.value; } else { old = v.tramos[+ix].bono; v.tramos[+ix].bono = +el.value; }
    await DB.update('reglas', { id: row.id }, { valor: v, actualizado_por: ACTOR, updated_at: new Date().toISOString() }); await DB.audit('reglas', 'cambio', `${clave} ${f}[${ix}]: ${old} → ${el.value}`, ACTOR, false, row.id); toast('Meta actualizada'); await loadAll(); render(); };
  ['meta', 'pts', 'td', 'tb'].forEach(f => document.querySelectorAll(`[data-${f}]`).forEach(el => el.onchange = () => save(el, f)));
}
function detalleInd(rid) {
  const r = S.rutas.find(x => x.id === rid); const v = veh(r.vehiculo_id) || {}; const e = evaluar(r, prevDe(r)); const ent = S.paradas.filter(p => p.ruta_id === rid && p.tipo === 'entrega'); const inc = S.incidencias.filter(i => i.ruta_id === rid);
  const dev = ent.filter(s => ['parcial', 'no_entregada'].includes(s.estado)); const recl = inc.filter(i => i.tipo === 'reclamo'); const falt = inc.filter(i => i.tipo === 'faltante');
  modal(`<div class="hd"><div><h2><span class="swatch" style="background:${r.color}"></span>${r.codigo} · ${esc(r.conductor)}${r.ayudante ? ' + ' + esc(r.ayudante) : ''}</h2><div class="mini">${v.placa} · ${e.prog === 'paneles' ? 'Programa Paneles (diario)' : 'Programa Camiones / Fuso (por viaje)'} · ${e.d.cerrada ? 'ruta cerrada' : 'preliminar: ruta sin cerrar'}</div></div><span class="score">${e.puntaje} pts</span></div>
  <div class="tw"><table><thead><tr><th>Indicador</th><th>Meta</th><th class="num">Resultado</th><th class="num">Pts</th><th>Corregir dato</th></tr></thead><tbody>${e.ind.map(i => `<tr><td>${esc(i.n)}${i.manual ? `<div class="mini">manual: ${esc(i.motivo || '')}</div>` : ''}</td><td class="mini">${esc(metaTxt(i))}</td><td class="num"><span class="${i.nd ? 'ind-nd' : i.cumple ? 'ind-ok' : 'ind-no'}">${esc(fmtInd(i))}</span></td><td class="num">${i.puntos}/${i.pts}</td><td><input data-man="${i.k}" placeholder="${i.u === 'hora' ? 'HH:MM' : 'valor'}" style="width:80px"></td></tr>`).join('')}${e.pen ? `<tr><td colspan="3">Factura entregada con faltante (penalidad)</td><td class="num ind-no">${e.pen}</td><td></td></tr>` : ''}</tbody></table></div>
  <label class="f" style="margin-top:6px">Motivo de la corrección (obligatorio si corriges)<input id="in-mot" placeholder="Ej.: combustible según estado de cuenta Tarjeta Flota Delta"></label>
  ${e.prog === 'camiones' ? `<div class="row" style="margin-top:8px"><label class="f">Pallets salida<input type="number" id="in-ps" value="${r.pallets_salida ?? ''}" style="width:70px"></label><label class="f">Pallets devueltos<input type="number" id="in-pr" value="${r.pallets_retorno ?? ''}" style="width:70px"></label><label class="f">Buen estado<select id="in-pb"><option value="">—</option><option value="1" ${r.pallets_buen_estado === true ? 'selected' : ''}>Sí</option><option value="0" ${r.pallets_buen_estado === false ? 'selected' : ''}>No</option></select></label></div>` : ''}
  <h3 style="margin:12px 0 6px">Devoluciones, faltantes y reclamos (los justificados no restan)</h3>
  <div class="stack" style="gap:6px">${dev.map(s => { const c = cli(s.cliente_id); const j = inc.find(i => i.tipo === 'devolucion' && i.parada_id === s.id); return `<label class="row mini"><input type="checkbox" data-jdev="${s.id}" ${j && j.justificada ? 'checked' : ''}> Devolución · ${esc(c.nombre)} · ${esc(s.resultado || s.estado)}</label>`; }).join('')}
  ${falt.map(i => `<label class="row mini"><input type="checkbox" data-jinc="${i.id}" ${i.justificada ? 'checked' : ''}> Faltante en verificación · ${esc(i.descripcion)}</label>`).join('')}
  ${recl.map(i => `<label class="row mini"><input type="checkbox" data-jinc="${i.id}" ${i.justificada ? 'checked' : ''}> Reclamo · ${esc(i.descripcion)}</label>`).join('')}
  ${!dev.length && !falt.length && !recl.length ? '<span class="mini">Sin devoluciones, faltantes ni reclamos.</span>' : ''}</div>
  <div class="row" style="margin-top:8px"><select id="in-rc-cli" class="xs">${[...new Set(ent.map(s => s.cliente_id))].map(id => `<option value="${id}">${esc(cli(id).nombre)}</option>`).join('')}</select><input id="in-rc" placeholder="Registrar reclamo del cliente" style="flex:1"><button class="btn sec xs" id="in-rc-ok">Registrar reclamo</button></div>
  <label class="row mini" style="margin-top:10px"><input type="checkbox" id="in-anu" ${e.anulado ? 'checked' : ''}> Anular el bono (información falsa${e.prog === 'camiones' ? ', daño o mal manejo del producto' : ''})</label><input id="in-anu-m" placeholder="Motivo de la anulación" value="${esc(e.motivo_anulacion || '')}">
  <div class="row" style="margin-top:12px;justify-content:flex-end"><button class="btn sec" id="in-x">Cerrar</button><button class="btn" id="in-ok">Guardar</button></div>`);
  $('in-x').onclick = closeModal;
  $('in-rc-ok').onclick = async () => { const t = $('in-rc').value.trim(); if (!t) return; await DB.insert('incidencias', { ruta_id: rid, tipo: 'reclamo', descripcion: `${cli($('in-rc-cli').value).nombre}: ${t}`, estado: 'registrada', actor: ACTOR, cliente_id: $('in-rc-cli').value, created_at: new Date().toISOString() }); await DB.audit('incidencias', 'reclamo', `${r.codigo}: reclamo de ${cli($('in-rc-cli').value).nombre} · ${t}`, ACTOR, false, rid); await loadAll(); render(); detalleInd(rid); };
  $('in-ok').onclick = async () => {
    if (!exige('incentivos')) return; const mot = $('in-mot').value.trim(); const mans = [...document.querySelectorAll('[data-man]')].filter(i => i.value.trim() !== '');
    if (mans.length && !mot) { toast('Escribe el motivo de la corrección'); return; }
    for (const cb of document.querySelectorAll('[data-jdev]')) { const j = inc.find(i => i.tipo === 'devolucion' && i.parada_id === cb.dataset.jdev); if (j) await DB.update('incidencias', { id: j.id }, { justificada: cb.checked }); else if (cb.checked) await DB.insert('incidencias', { ruta_id: rid, parada_id: cb.dataset.jdev, tipo: 'devolucion', descripcion: 'Devolución justificada', justificada: true, estado: 'cerrada', actor: ACTOR, created_at: new Date().toISOString() }); }
    for (const cb of document.querySelectorAll('[data-jinc]')) await DB.update('incidencias', { id: cb.dataset.jinc }, { justificada: cb.checked });
    if (e.prog === 'camiones') await DB.update('rutas', { id: rid }, { pallets_salida: $('in-ps').value === '' ? null : +$('in-ps').value, pallets_retorno: $('in-pr').value === '' ? null : +$('in-pr').value, pallets_buen_estado: $('in-pb').value === '' ? null : $('in-pb').value === '1' });
    await loadAll(); const r2 = S.rutas.find(x => x.id === rid); const prev = prevDe(r2) || {}; const base = evaluar(r2, prev);
    const ind = base.ind.map(i => { const m = mans.find(x => x.dataset.man === i.k); return m ? Object.assign({}, i, { valor: i.u === 'hora' ? m.value.trim() : +m.value, manual: true, motivo: mot }) : i; });
    const rec = { fecha: hoy(), semana: semanaISO(hoy()), ruta_codigo: r2.codigo, vehiculo_placa: v.placa, programa: base.prog, conductor: r2.conductor, ayudante: r2.ayudante, indicadores: ind, puntaje: 0, anulado: $('in-anu').checked, motivo_anulacion: $('in-anu').checked ? ($('in-anu-m').value || 'anulado') : null, demo: false, calculado_por: ACTOR };
    const e2 = evaluar(r2, rec); rec.indicadores = e2.ind.map(({ k, n, meta, op, u, pts, valor, cumple, puntos, nd, manual, motivo }) => ({ k, n, meta, op, u, pts, valor, cumple, puntos, nd, manual, motivo })); rec.puntaje = e2.puntaje;
    await DB.remove('incentivos', { fecha: hoy(), ruta_codigo: r2.codigo, demo: false }); await DB.insert('incentivos', [rec]);
    await DB.audit('incentivos', 'ajuste', `${r2.codigo}: ${mans.length ? mans.map(m => m.dataset.man + '=' + m.value).join(', ') + ' · motivo: ' + mot + ' · ' : ''}puntaje ${rec.puntaje}${rec.anulado ? ' · BONO ANULADO: ' + rec.motivo_anulacion : ''}`, ACTOR, false, rid);
    closeModal(); toast('Incentivo actualizado'); await loadAll(); render();
  };
}
document.querySelectorAll('#in-tabs button').forEach(b => b.onclick = () => { IN.tab = b.dataset.t; renderIncentivos(); });
$('in-calc').onclick = calcularDia; $('in-demo').onclick = semanaDemo;
$('in-csv').onclick = () => { if (IN.tab !== 'semana') { IN.tab = 'semana'; renderIncentivos(); } const res = IN._res || []; if (!res.length) return toast('Sin datos de la semana'); descargarCSV(`bonos_${IN.semana}.csv`, [['Semana', 'Programa', 'Conductor', 'Ayudante', 'Vehículo', 'Registros', 'Puntaje promedio', 'Bono B/.', 'Observación'], ...res.map(x => [IN.semana, x.prog, x.cond, x.ayu, x.placa, x.xs.length, x.prom.toFixed(1), x.bono, x.motivo])]); };
