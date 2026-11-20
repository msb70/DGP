/* DGP · Recepción de camiones al regreso del viaje (20-nov-2026).
   Acta firmada por el conductor (entrega) y por bodega (recibe) con todo el detalle del viaje:
   entregas (resultado, causa, quién recibió, firma, fotos), devoluciones contadas en bodega, incidentes, cobros, odómetro y pallets.
   En producción lo graba registrar_recepcion (una recepción por viaje; el acta no se modifica). */
const RC = { tab: 'pend', rutas: [], actas: [], recibidas: new Set() };
const rcHora = t => t ? new Date(t).toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit' }) : '—';
const RC_RES = { atendida: ['Entregada', 'p-ok'], parcial: ['Parcial', 'p-warn'], no_entregada: ['No entregada', 'p-crit'], pendiente: ['Sin gestionar', 'p-mut'], en_sitio: ['Sin cerrar', 'p-mut'], reprogramada: ['Reprogramada', 'p-info'] };

async function rcCargar() {
  try {
    const rs = await DB.all('rutas', { estado: ['en_ruta', 'cerrada', 'conciliada'] }, 'fecha', { desc: true, limit: 400 });
    if (DB.getMode() === 'supabase') { const { data, error } = await DB.client().from('recepciones').select('id,created_at,ruta_id,ruta_codigo,ruta_fecha,placa,conductor,recibe,registrado_por,diferencias,observaciones').order('created_at', { ascending: false }).limit(200); if (error) throw error; RC.actas = data || []; }
    else RC.actas = (await DB.all('recepciones', null, 'created_at', { desc: true, limit: 200 })) || [];
    RC.recibidas = new Set(RC.actas.map(a => a.ruta_id)); RC.rutas = rs;
  } catch (e) { RC.rutas = []; RC.actas = []; toast('No se pudo leer la recepción: ' + (e.message || e)); }
}
async function renderRecepcion(recargar) {
  const box = $('rc-body'); if (!box) return;
  if (recargar || !RC.cargado) { box.innerHTML = '<div class="empty">Cargando…</div>'; await rcCargar(); RC.cargado = true; }
  document.querySelectorAll('#rc-tabs button').forEach(b => { b.classList.toggle('on', b.dataset.t === RC.tab); b.onclick = () => { RC.tab = b.dataset.t; renderRecepcion(); }; });
  const ed = puede('recepcion.registrar');
  if (RC.tab === 'pend') {
    const P = RC.rutas.filter(r => !RC.recibidas.has(r.id) && r.estado !== 'conciliada').sort((a, b) => (a.estado === 'cerrada' ? 0 : 1) - (b.estado === 'cerrada' ? 0 : 1) || (b.fecha || '').localeCompare(a.fecha || ''));
    box.innerHTML = `<div class="tw"><table><thead><tr><th>Viaje</th><th>Camión</th><th>Conductor</th><th>Estado</th><th>Llegada</th><th class="num">Km</th><th></th></tr></thead><tbody>${P.map(r => { const v = veh(r.vehiculo_id) || {}; return `<tr><td><b>${esc(r.codigo)}</b> <span class="mini">${esc(r.fecha || '')}</span></td><td class="code">${esc(v.placa || '')}</td><td>${esc(r.conductor || '—')}</td><td>${rpill(r.estado)}${r.estado === 'en_ruta' ? '<br><span class="mini">el conductor no ha registrado la llegada</span>' : ''}</td><td class="mini">${r.llegada_at ? new Date(r.llegada_at).toLocaleString('es-PA') : '—'}</td><td class="num">${r.km_real ?? '—'}</td><td>${ed ? `<button class="btn ${r.estado === 'cerrada' ? '' : 'sec'} sm" data-rc="${r.id}">Recibir camión</button>` : '<span class="mini">sin permiso</span>'}</td></tr>`; }).join('') || '<tr><td colspan="7" class="note">No hay camiones por recibir.</td></tr>'}</tbody></table></div>`;
    document.querySelectorAll('[data-rc]').forEach(b => b.onclick = () => rcRecibir(b.dataset.rc));
  } else {
    box.innerHTML = `<div class="tw"><table><thead><tr><th>Fecha y hora</th><th>Viaje</th><th>Camión</th><th>Entregó</th><th>Recibió</th><th>Devoluciones</th><th></th></tr></thead><tbody>${RC.actas.map(a => `<tr><td class="mini">${new Date(a.created_at).toLocaleString('es-PA')}</td><td><b>${esc(a.ruta_codigo || '')}</b> <span class="mini">${esc(a.ruta_fecha || '')}</span></td><td class="code">${esc(a.placa || '')}</td><td>${esc(a.conductor || '')}</td><td>${esc(a.recibe)}</td><td>${a.diferencias ? `<span class="pill p-crit">${a.diferencias} con diferencia</span>` : '<span class="pill p-ok">Cuadran</span>'}</td><td><button class="btn sec xs" data-rc-acta="${a.id}">Ver / imprimir acta</button></td></tr>`).join('') || '<tr><td colspan="7" class="note">Aún no hay actas de recepción.</td></tr>'}</tbody></table></div>`;
    document.querySelectorAll('[data-rc-acta]').forEach(b => b.onclick = () => rcImprimirActa(b.dataset.rcActa));
  }
}

/* Junta todo lo del viaje en un resumen (queda guardado en el acta tal como estaba al recibir). */
async function rcDatos(r) {
  const [paradas, incid, cobros, abast] = await Promise.all(['paradas', 'incidencias', 'cobros', 'abastecimientos'].map(t => porIds(t, 'ruta_id', [r.id]).catch(() => [])));
  const ent = paradas.filter(p => p.tipo === 'entrega' || p.tipo === 'servicio').sort((a, b) => a.secuencia - b.secuencia);   // las paradas de servicio también van al acta
  const pids = [...new Set(ent.map(p => p.pedido_id).filter(Boolean))];
  const pedidos = await porIds('pedidos', 'id', pids).catch(() => []); const lineas = await porIds('pedido_lineas', 'pedido_id', pids).catch(() => []);
  const ped = id => pedidos.find(p => p.id === id) || {}; const art = sku => (S.articulos.find(a => a.sku === sku) || {}).nombre || sku;
  const entregas = ent.map(p => { const pd = ped(p.pedido_id); const k = cli(p.cliente_id) || {}; return { sec: p.secuencia, cliente: k.nombre || '', factura: p.tipo === 'servicio' ? '🔧 Servicio' : (pd.numero_factura || pd.numero_so || ''), valor: +pd.valor || 0, estado: p.estado, resultado: p.resultado || '', receptor: p.receptor || '', firma: !!p.firma, fotos: (p.fotos || []).length || (p.foto ? 1 : 0), llegada: p.checkin_at, salida: p.checkout_at, distancia: p.distancia_checkin_m }; });
  // devoluciones: lo no entregado de parciales y no entregadas
  const devoluciones = [];
  ent.filter(p => ['parcial', 'no_entregada'].includes(p.estado)).forEach(p => { const pd = ped(p.pedido_id); lineas.filter(l => l.pedido_id === p.pedido_id).forEach(l => { const ent2 = p.estado === 'no_entregada' ? 0 : (l.entregado ?? l.cantidad_cajas); const dev = (+l.cantidad_cajas || 0) - (+ent2 || 0); if (dev > 0) devoluciones.push({ factura: pd.numero_factura || pd.numero_so || '', cliente: (cli(p.cliente_id) || {}).nombre || '', sku: l.sku, articulo: art(l.sku), esperado: dev, recibido: dev }); }); });
  const tipoN = t => t === 'demora' ? 'Demora' : ((typeof catxBuscar === 'function' && catxBuscar('tipos_incidente', t)) || {}).nombre || t;
  const incidentes = incid.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '')).map(i => ({ id: i.id, hora: i.created_at, tipo: tipoN(i.tipo), descripcion: i.descripcion || '', demora_min: i.demora_min || null, estado: i.estado, foto: !!i.foto }));
  const cob = cobros.filter(c => c.estado !== 'anulado').map(c => ({ cliente: (cli(c.cliente_id) || {}).nombre || '', documento: c.documento || '', monto: +c.monto, forma: c.forma, banco: c.banco || '', numero: c.numero_cheque || '', estado: c.estado, recibido: c.monto_recibido != null ? +c.monto_recibido : null, causa: c.causa_nombre || '' }));
  const cuenta = e => entregas.filter(x => x.estado === e).length; const v = veh(r.vehiculo_id) || {};
  return { entregas, devoluciones, incidentes, cobros: cob, fotosInc: incid.filter(i => i.foto),
    resumen: { ruta: { codigo: r.codigo, fecha: r.fecha, placa: v.placa || '', camion: v.nombre || '', conductor: r.conductor || '', ayudante: r.ayudante || '', salida: r.salida_at, llegada: r.llegada_at, odometro_salida: r.odometro_salida, odometro_llegada: r.odometro_llegada, km_plan: r.km_plan, km_real: r.km_real, pallets_salida: r.pallets_salida, pallets_retorno: r.pallets_retorno, pallets_buen_estado: r.pallets_buen_estado, combustible_litros: abast.reduce((s, x) => s + (+x.litros || 0), 0) },
      totales: { paradas: entregas.length, entregadas: cuenta('atendida'), parciales: cuenta('parcial'), no_entregadas: cuenta('no_entregada'), sin_gestionar: entregas.length - cuenta('atendida') - cuenta('parcial') - cuenta('no_entregada'), incidentes: incidentes.length, cobros: cob.length, cobrado: cob.reduce((s, c) => s + (c.recibido || 0), 0), no_cobrado: cob.filter(c => c.estado === 'no_recibido').length },
      entregas, incidentes, cobros: cob } };
}

const rcSecciones = (R, devHtml) => {
  const t = R.totales, ru = R.ruta;
  return `<h3 style="margin:10px 0 4px">Entregas · ${t.entregadas} completas · ${t.parciales} parciales · ${t.no_entregadas} no entregadas${t.sin_gestionar ? ` · <span style="color:var(--crit)">${t.sin_gestionar} sin gestionar</span>` : ''}</h3>
    <div class="tw"><table><thead><tr><th>#</th><th>Cliente</th><th>Factura</th><th>Resultado</th><th>Detalle / causa</th><th>Recibió</th><th>Evidencia</th><th>Hora</th></tr></thead><tbody>${R.entregas.map(e => { const x = RC_RES[e.estado] || [e.estado, 'p-mut']; return `<tr><td class="num">${e.sec}</td><td>${esc(e.cliente)}</td><td class="code">${esc(e.factura)}</td><td><span class="pill ${x[1]}">${x[0]}</span></td><td class="mini">${esc(e.resultado)}</td><td>${esc(e.receptor || '—')}</td><td class="mini">${e.firma ? 'firma ✔' : 'sin firma'}${e.fotos ? ` · ${e.fotos} foto${e.fotos > 1 ? 's' : ''}` : ''}</td><td class="mini">${rcHora(e.llegada)}–${rcHora(e.salida)}</td></tr>`; }).join('') || '<tr><td colspan="8" class="note">Sin entregas.</td></tr>'}</tbody></table></div>
    ${devHtml}
    <h3 style="margin:14px 0 4px">Incidentes reportados (${R.incidentes.length})</h3>
    <div class="tw"><table><thead><tr><th>Hora</th><th>Tipo</th><th>Descripción</th><th>Estado</th><th>Foto</th></tr></thead><tbody>${R.incidentes.map(i => `<tr><td class="mini">${rcHora(i.hora)}</td><td><b>${esc(i.tipo)}</b></td><td>${esc(i.descripcion)}${i.demora_min ? ` · ${i.demora_min} min` : ''}</td><td>${esc(i.estado || '')}</td><td>${i.foto ? (i.id ? `<a href="#" data-rc-foto="${i.id}">📷 ver</a>` : '📷') : '—'}</td></tr>`).join('') || '<tr><td colspan="5" class="note">Sin incidentes reportados.</td></tr>'}</tbody></table></div>
    ${R.cobros.length ? `<h3 style="margin:14px 0 4px">Cobros del viaje (${R.cobros.length}) · recibido B/. ${fmt(t.cobrado)}</h3><div class="tw"><table><thead><tr><th>Cliente</th><th>Documento</th><th>Forma</th><th class="num">A cobrar</th><th>Estado</th><th class="num">Recibido</th></tr></thead><tbody>${R.cobros.map(c => `<tr><td>${esc(c.cliente)}</td><td class="code">${esc(c.documento)}</td><td>${c.forma === 'cheque' ? `Cheque ${esc(c.banco)} nº ${esc(c.numero)}` : 'Efectivo'}</td><td class="num">${fmt(c.monto)}</td><td>${typeof cbPill === 'function' ? cbPill(c.estado) : esc(c.estado)}${c.causa ? `<br><span class="mini">${esc(c.causa)}</span>` : ''}</td><td class="num">${c.recibido != null ? fmt(c.recibido) : '—'}</td></tr>`).join('')}</tbody></table></div><p class="mini">El efectivo y los cheques se entregan con firma en «Cobros en ruta».</p>` : ''}
    <div class="mini" style="margin-top:8px">Odómetro ${ru.odometro_salida ?? '—'} → ${ru.odometro_llegada ?? '—'} · ${ru.km_real ?? '—'} km (plan ${ru.km_plan ?? '—'}) · pallets salida ${ru.pallets_salida ?? '—'} / retorno ${ru.pallets_retorno ?? '—'}${ru.pallets_buen_estado === false ? ' (con daño)' : ''} · combustible ${ru.combustible_litros || 0} L</div>`;
};

async function rcRecibir(rid) {
  if (!exige('recepcion.registrar')) return;
  const r = RC.rutas.find(x => x.id === rid) || S.rutas.find(x => x.id === rid); if (!r) return;
  modal('<div class="empty">Juntando entregas, devoluciones e incidentes del viaje…</div>'); $('modal-body').classList.add('wide');
  const D = await rcDatos(r); const v = veh(r.vehiculo_id) || {}; const camion = v.tipo === 'camion';
  const devHtml = `<h3 style="margin:14px 0 4px">Devoluciones a bodega (${D.devoluciones.length} línea${D.devoluciones.length === 1 ? '' : 's'}) · cuenta lo que regresa</h3>${D.devoluciones.length ? `<div class="tw"><table><thead><tr><th>Factura</th><th>Cliente</th><th>Artículo</th><th class="num">Debe regresar</th><th class="num">Recibido en bodega</th></tr></thead><tbody>${D.devoluciones.map((d, i) => `<tr><td class="code">${esc(d.factura)}</td><td>${esc(d.cliente)}</td><td>${esc(d.articulo)} <span class="mini">${esc(d.sku)}</span></td><td class="num">${d.esperado}</td><td class="num"><input type="number" min="0" step="1" data-rc-dev="${i}" value="${d.esperado}" style="width:80px;text-align:right"></td></tr>`).join('')}</tbody></table></div>` : '<p class="mini">No hay devoluciones: todo se entregó completo.</p>'}`;
  modal(`<div class="hd"><div><h2>Recepción del camión · ${esc(r.codigo)} <span class="mini">${esc(r.fecha || '')}</span></h2><div class="mini">${esc(v.placa || '')} ${esc(v.nombre || '')} · conductor <b>${esc(r.conductor || '—')}</b>${r.ayudante ? ' · ayudante ' + esc(r.ayudante) : ''} · salió ${r.salida_at ? new Date(r.salida_at).toLocaleString('es-PA') : '—'} · llegó ${r.llegada_at ? new Date(r.llegada_at).toLocaleString('es-PA') : '—'}</div></div></div>
    ${r.estado === 'en_ruta' ? `<div class="form-err" style="display:block;background:#fff7e6;border-color:#f5b041;color:#7a4b00">El conductor no registró la llegada en su app. Escribe el odómetro de llegada: la recepción cierra la ruta.</div><label class="mini">Odómetro de llegada (km) *<input id="rc-odo" type="number" min="1" step="1" placeholder="${r.odometro_salida ? 'Salió con ' + r.odometro_salida : 'Lectura actual'}" style="width:200px"></label>` : ''}
    ${rcSecciones(D.resumen, devHtml)}
    ${camion ? `<div class="row" style="gap:14px;margin-top:10px"><label class="mini">Pallets que regresan<input id="rc-pal" type="number" min="0" step="1" value="${r.pallets_retorno ?? r.pallets_salida ?? ''}" style="width:90px"></label><label class="mini"><input type="checkbox" id="rc-palb" ${r.pallets_buen_estado === false ? '' : 'checked'}> Pallets en buen estado</label></div>` : ''}
    <label class="mini" style="display:block;margin-top:10px">Observaciones de la recepción<textarea id="rc-obs" rows="2" maxlength="600" style="width:100%" placeholder="Obligatorio si una devolución no cuadra"></textarea></label>
    <div class="grid g2" style="gap:14px;margin-top:10px">
      <div><label class="mini">Entrega: <b>${esc(r.conductor || 'conductor')}</b> — firma del conductor * <a href="#" id="rc-l1" style="float:right">Limpiar</a></label><canvas id="rc-f1" style="width:100%;height:130px;border:1px dashed #94A3B8;border-radius:10px;background:#fff;display:block"></canvas></div>
      <div><label class="mini">Recibe en bodega * <a href="#" id="rc-l2" style="float:right">Limpiar</a><input id="rc-rec" maxlength="80" value="${esc(ACTOR)}" style="width:100%;margin:2px 0 4px"></label><canvas id="rc-f2" style="width:100%;height:130px;border:1px dashed #94A3B8;border-radius:10px;background:#fff;display:block"></canvas></div>
    </div>
    <div class="form-err" id="rc-err" hidden></div>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn sec" onclick="closeModal()">Cancelar</button><button class="btn" id="rc-ok">Firmar recepción e imprimir acta</button></div>`);
  $('modal-body').classList.add('wide');
  const f1 = cbFirma($('rc-f1')), f2 = cbFirma($('rc-f2'));
  $('rc-l1').onclick = e => { e.preventDefault(); f1.limpiar(); }; $('rc-l2').onclick = e => { e.preventDefault(); f2.limpiar(); };
  document.querySelectorAll('[data-rc-foto]').forEach(a => a.onclick = e => { e.preventDefault(); const i = D.fotosInc.find(x => x.id === a.dataset.rcFoto); if (i) window.open().document.write(`<img src="${i.foto}" style="max-width:100%">`); });
  document.querySelectorAll('[data-rc-dev]').forEach(i => i.oninput = () => { const d = D.devoluciones[+i.dataset.rcDev]; i.style.background = +i.value !== d.esperado ? '#FEF2F2' : ''; });
  $('rc-ok').onclick = async () => {
    document.querySelectorAll('.campo-error').forEach(x => x.classList.remove('campo-error'));
    let odo = null; if (r.estado === 'en_ruta') { odo = Math.round(+$('rc-odo').value); if (!(odo > 0)) return formError('rc-err', 'Escribe el odómetro de llegada.', 'rc-odo'); if (r.odometro_salida && odo < +r.odometro_salida) return formError('rc-err', `El odómetro de llegada no puede ser menor que el de salida (${r.odometro_salida}).`, 'rc-odo'); }
    const dev = D.devoluciones.map((d, i) => Object.assign({}, d, { recibido: $(`[data-rc-dev="${i}"]`) ? +$(`[data-rc-dev="${i}"]`).value : d.esperado }));
    const malo = dev.findIndex(d => !Number.isInteger(d.recibido) || d.recibido < 0); if (malo >= 0) return formError('rc-err', `Revisa la cantidad recibida de ${dev[malo].articulo}.`);
    const dif = dev.filter(d => d.recibido !== d.esperado).length; const obs = $('rc-obs').value.trim();
    if (dif && obs.length < 3) return formError('rc-err', `${dif} devolución(es) no cuadran: explica en observaciones.`, 'rc-obs');
    const fc = f1.get(); if (!fc) return formError('rc-err', 'Falta la firma del conductor.', 'rc-f1');
    const rec = $('rc-rec').value.trim(); if (rec.length < 3) return formError('rc-err', 'Escribe quién recibe en bodega.', 'rc-rec');
    const fr = f2.get(); if (!fr) return formError('rc-err', 'Falta la firma de quien recibe.', 'rc-f2');
    const pal = $('rc-pal') && $('rc-pal').value !== '' ? Math.round(+$('rc-pal').value) : null; const palb = $('rc-palb') ? $('rc-palb').checked : null;
    if (pal != null) { D.resumen.ruta.pallets_retorno = pal; D.resumen.ruta.pallets_buen_estado = palb; }
    if (odo) { D.resumen.ruta.odometro_llegada = odo; D.resumen.ruta.km_real = r.odometro_salida ? odo - r.odometro_salida : null; }
    $('rc-ok').disabled = true; let res;
    try {
      if (DB.getMode() === 'supabase') res = await DB.rpc('registrar_recepcion', { rid: r.id, recibe: rec, firma_recibe: fr, firma_conductor: fc, devoluciones: dev, resumen: D.resumen, observaciones: obs || null, odometro: odo, pallets_retorno: pal, pallets_buen_estado: palb });
      else {
        if (RC.recibidas.has(r.id)) throw new Error(`El viaje ${r.codigo} ya fue recibido`);
        if (odo) await DB.update('rutas', { id: r.id }, { estado: 'cerrada', llegada_at: new Date().toISOString(), odometro_llegada: odo, km_real: D.resumen.ruta.km_real });
        const id = DB.uuid(); await DB.insert('recepciones', [{ id, created_at: new Date().toISOString(), ruta_id: r.id, ruta_codigo: r.codigo, ruta_fecha: r.fecha, placa: v.placa, conductor: r.conductor, firma_conductor: fc, recibe: rec, firma_recibe: fr, registrado_por: ACTOR, odometro_llegada: odo || r.odometro_llegada, pallets_retorno: pal, pallets_buen_estado: palb, observaciones: obs || null, devoluciones: dev, diferencias: dif, resumen: D.resumen }]);
        await DB.audit('recepciones', 'camion_recibido', `${r.codigo} · recibe ${rec} · ${dev.length} devoluciones${dif ? ' · ' + dif + ' con diferencia' : ''}`, ACTOR, false, id); res = { ok: true, id, diferencias: dif };
      }
    } catch (e) { $('rc-ok').disabled = false; return formError('rc-err', e.message || String(e)); }
    closeModal(); toast(`Camión ${r.codigo} recibido${res.diferencias ? ` · ${res.diferencias} devolución(es) con diferencia (alerta enviada)` : ''}`);
    RC.tab = 'hechas'; await renderRecepcion(true); rcImprimirActa(res.id);
  };
}

async function rcImprimirActa(id) {
  let a;
  try { if (DB.getMode() === 'supabase') { const { data, error } = await DB.client().from('recepciones').select('*').eq('id', id).single(); if (error) throw error; a = data; } else a = (await DB.all('recepciones', { id }))[0]; }
  catch (e) { return toast('No se pudo leer el acta: ' + (e.message || e)); }
  if (!a) return toast('Acta no encontrada'); const R = a.resumen || {}; const ru = R.ruta || {}; const t = R.totales || {};
  const dev = (a.devoluciones || []);
  const devHtml = `<h3>Devoluciones a bodega</h3>${dev.length ? `<table><thead><tr><th>Factura</th><th>Cliente</th><th>Artículo</th><th class="num">Debe regresar</th><th class="num">Recibido</th></tr></thead><tbody>${dev.map(d => `<tr><td>${esc(d.factura)}</td><td>${esc(d.cliente)}</td><td>${esc(d.articulo)} (${esc(d.sku)})</td><td class="num">${d.esperado}</td><td class="num"${d.recibido !== d.esperado ? ' style="font-weight:700;color:#B91C1C"' : ''}>${d.recibido}</td></tr>`).join('')}</tbody></table>` : '<p>Sin devoluciones.</p>'}`;
  imprimir(`<div class="pp"><h2 style="margin:0">DGP · Acta de recepción del camión</h2>
    <div class="meta"><b>Viaje</b><span>${esc(a.ruta_codigo || '')} · ${esc(a.ruta_fecha || '')}</span><b>Camión</b><span>${esc(a.placa || '')} ${esc(ru.camion || '')}</span><b>Conductor</b><span>${esc(a.conductor || '')}${ru.ayudante ? ' · ayudante ' + esc(ru.ayudante) : ''}</span>
    <b>Salida / llegada</b><span>${ru.salida ? new Date(ru.salida).toLocaleString('es-PA') : '—'} → ${ru.llegada ? new Date(ru.llegada).toLocaleString('es-PA') : '—'}</span><b>Odómetro</b><span>${ru.odometro_salida ?? '—'} → ${a.odometro_llegada ?? ru.odometro_llegada ?? '—'} km · recorrido ${ru.km_real ?? '—'} km</span>
    <b>Pallets</b><span>salida ${ru.pallets_salida ?? '—'} · retorno ${a.pallets_retorno ?? '—'}${a.pallets_buen_estado === false ? ' (con daño)' : ''}</span><b>Recibido</b><span>${new Date(a.created_at).toLocaleString('es-PA')} · registró ${esc(a.registrado_por || '')}</span>
    <b>Resumen</b><span>${t.paradas ?? 0} entregas: ${t.entregadas ?? 0} completas, ${t.parciales ?? 0} parciales, ${t.no_entregadas ?? 0} no entregadas · ${t.incidentes ?? 0} incidentes · ${t.cobros ?? 0} cobros (recibido B/. ${fmt(t.cobrado || 0)})</span></div>
    ${rcSecciones(R, devHtml).replace(/class="tw"/g, '').replace(/<a href="#" data-rc-foto="[^"]*">📷 ver<\/a>/g, '📷')}
    ${a.observaciones ? `<p><b>Observaciones:</b> ${esc(a.observaciones)}</p>` : ''}
    <div class="firmas"><div><img src="${a.firma_conductor}" style="height:70px;display:block;margin:0 auto">Entrega (conductor): ${esc(a.conductor || '')}</div><div><img src="${a.firma_recibe}" style="height:70px;display:block;margin:0 auto">Recibe (bodega): ${esc(a.recibe)}</div></div></div>`);
}
