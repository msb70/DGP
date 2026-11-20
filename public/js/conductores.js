/* DGP · Cambio de conductor (20-nov-2026). Módulo por ruta y por camión, con historial.
   · Primera asignación (sin conductor): verificar / planificar.  · Cambiar o quitar: permiso conductor.cambiar + motivo + quién lo autorizó.
   · En producción lo hacen las funciones asignar_conductor / asignar_conductor_vehiculo (atómicas; la base bloquea cambios por otra vía)
     y cada operación queda en conductor_cambios (anterior → nuevo, motivo, autorizó, ejecutó, viajes afectados). */
const CC = { tab: 'rutas', hist: null, autorizadores: null, filtro: '' };
const CC_ABIERTAS = ['simulada', 'aprobada', 'publicada', 'en_cargue', 'liberada'];   // todo lo que aún no salió
const ccFV = x => `${x.codigo} ${String(x.fecha || '').slice(8, 10)}/${String(x.fecha || '').slice(5, 7)}`;
const ccPuedeCambiar = () => puede('conductor.cambiar');
const ccPuedeAsignar = () => puede('verificar') || puede('planificar') || puede('catalogo.editar') || ccPuedeCambiar();

async function ccAutorizadores() {
  if (CC.autorizadores) return CC.autorizadores;
  try { CC.autorizadores = DB.getMode() === 'supabase' ? (await DB.rpc('autorizadores_conductor', {}) || []).map(x => typeof x === 'string' ? x : Object.values(x)[0]) : [ACTOR]; }
  catch (e) { CC.autorizadores = [ACTOR]; }
  return CC.autorizadores;
}
async function ccHistorial() {
  try { CC.hist = await DB.all('conductor_cambios', null, 'created_at', { desc: true, limit: 500 }); }
  catch (e) { CC.hist = []; }
  CC.hist.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

/* Ejecuta la asignación (ruta o camión). Devuelve el resultado o lanza el error de la base. */
async function ccEjecutar({ tipo, id, nombre, motivo, autorizado }) {
  if (DB.getMode() === 'supabase') return tipo === 'ruta' ? DB.rpc('asignar_conductor', { rid: id, nombre, motivo: motivo || null, autorizado: autorizado || null }) : DB.rpc('asignar_conductor_vehiculo', { vid: id, nombre: nombre || null, motivo: motivo || null, autorizado: autorizado || null });
  // modo demo: misma lógica en el navegador
  const r = tipo === 'ruta' ? S.rutas.find(x => x.id === id) : null; const v = veh(tipo === 'ruta' ? r.vehiculo_id : id) || {};
  const ant = String((tipo === 'ruta' ? r.conductor : v.conductor) || '').trim() || null; const n = String(nombre || '').trim() || null;
  if (ant === n) return { ok: true, sin_cambio: true };
  const cambio = !!ant; if (cambio && !ccPuedeCambiar()) throw new Error('Cambiar o quitar un conductor requiere el permiso «conductor.cambiar»');
  if (cambio && String(motivo || '').trim().length < 3) throw new Error('Escribe el motivo del cambio de conductor');
  if (cambio && !autorizado) throw new Error('Indica quién autorizó el cambio');
  let quitado = [], vaciadas = [];
  if (!n && S.rutas.some(x => x.vehiculo_id === v.id && x.estado === 'liberada')) throw new Error(`El camión ${v.placa} tiene viajes ya liberados: no puede quedar sin conductor (cámbialo por otro)`);
  if (n) { const libs = S.rutas.filter(x => x.conductor === n && x.vehiculo_id !== v.id && x.estado === 'liberada'); if (libs.length) throw new Error(`${n} lleva viajes ya liberados en otro camión: ${libs.map(ccFV).join(', ')}. Asígnales otro conductor antes de moverlo`); }
  if (n) { const otros = S.vehiculos.filter(x => x.conductor === n && x.id !== v.id); quitado = otros.map(x => x.placa); for (const x of otros) await DB.update('vehiculos', { id: x.id }, { conductor: null });
    const qr = S.rutas.filter(x => x.conductor === n && x.vehiculo_id !== v.id && CC_ABIERTAS.includes(x.estado)); vaciadas = qr.map(ccFV); for (const x of qr) await DB.update('rutas', { id: x.id }, { conductor: null }); }
  await DB.update('vehiculos', { id: v.id }, { conductor: n });
  const pr = S.rutas.filter(x => x.vehiculo_id === v.id && CC_ABIERTAS.includes(x.estado)); for (const x of pr) await DB.update('rutas', { id: x.id }, { conductor: n });
  await DB.insert('conductor_cambios', [{ id: DB.uuid(), created_at: new Date().toISOString(), tipo, ruta_id: r ? r.id : null, ruta_codigo: r ? r.codigo : null, ruta_fecha: r ? r.fecha : null, vehiculo_id: v.id, placa: v.placa, anterior: ant, nuevo: n, es_cambio: cambio, motivo: motivo || null, autorizado_por: autorizado || null, ejecutado_por: ACTOR, rutas_actualizadas: pr.map(ccFV), quitado_de: quitado, rutas_sin_conductor: vaciadas }]);
  await DB.audit(tipo === 'ruta' ? 'rutas' : 'vehiculos', cambio ? 'conductor_cambiado' : 'conductor_asignado', `${r ? r.codigo + ' ' : ''}(${v.placa}): conductor ${ant || '—'} → ${n || 'sin conductor'}${cambio ? ` · motivo: ${motivo} · autorizó: ${autorizado}` : ''}`, ACTOR, false, r ? r.id : v.id);
  return { ok: true, placa: v.placa, quitado_de: quitado, rutas_actualizadas: pr.length, rutas: pr.map(ccFV), rutas_sin_conductor: vaciadas.length, vaciadas, cambio };
}
const ccResumen = (res, nombre) => res.sin_cambio ? 'Sin cambios' : `${nombre || 'Sin conductor'} en ${res.placa}${(res.rutas || []).length ? ` · viajes ${res.rutas.join(', ')}` : ''}${(res.quitado_de || []).length ? ` · se quitó de ${res.quitado_de.join(', ')}` : ''}${(res.vaciadas || []).length ? ` · quedan sin conductor ${res.vaciadas.join(', ')}` : ''}`;

/* Ventana de cambio. tipo 'ruta' | 'camion'. Si ya hay conductor pide motivo y autorizador (y permiso). */
async function ccModal(tipo, id, preset) {
  const r = tipo === 'ruta' ? S.rutas.find(x => x.id === id) : null; const v = veh(tipo === 'ruta' ? r && r.vehiculo_id : id) || {};
  if (tipo === 'ruta' && (!r || !CC_ABIERTAS.includes(r.estado))) return toast('La ruta ya salió: su conductor no se cambia');
  const ant = String((tipo === 'ruta' ? r.conductor : v.conductor) || '').trim();
  if (ant && !ccPuedeCambiar()) return toast('Cambiar un conductor ya asignado requiere el permiso «Cambiar o quitar el conductor» (Usuarios y permisos)');
  if (!ant && !ccPuedeAsignar()) return exige('verificar');
  const auts = ant ? await ccAutorizadores() : [];
  const lista = S.personas.filter(p => p.rol === 'conductor' && p.activo !== false).sort((a, b) => a.nombre.localeCompare(b.nombre));
  const abR = S.rutas.filter(x => x.vehiculo_id === v.id && CC_ABIERTAS.includes(x.estado)).sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
  const abiertas = abR.map(ccFV); const cargadas = abR.filter(x => x.estado === 'liberada');
  modal(`<div class="hd"><div><h2>${ant ? 'Cambiar' : 'Asignar'} conductor · ${tipo === 'ruta' ? esc(r.codigo) + ' · ' : ''}camión ${esc(v.placa || '')}</h2><div class="mini">${esc(v.nombre || '')} · conductor actual: <b>${esc(ant || 'ninguno')}</b></div></div></div>
    ${cargadas.length ? `<div class="form-err" style="display:block;background:#fff7e6;border-color:#f5b041;color:#7a4b00">⚠ ${cargadas.length === 1 ? 'El viaje' : 'Los viajes'} ${cargadas.map(x => esc(ccFV(x))).join(', ')} ya ${cargadas.length === 1 ? 'está cargado y su documentación liberada' : 'están cargados y su documentación liberada'}${ant ? ` a ${esc(ant)}` : ''}. El cambio queda en el historial: entrega la documentación al nuevo conductor.</div>` : ''}
    <label class="f">Nuevo conductor<select id="cc-n"><option value="">${tipo === 'camion' && ant ? '— Quitar el conductor del camión —' : '— Elegir conductor —'}</option>${lista.filter(p => p.nombre !== ant).map(p => { const en = S.vehiculos.find(x => x.conductor === p.nombre); return `<option value="${esc(p.nombre)}" ${preset === p.nombre ? 'selected' : ''}>${esc(p.nombre)}${en ? ` · hoy en ${esc(en.placa)}` : ' · libre'}</option>`; }).join('')}</select></label>
    <div class="mini" id="cc-imp" style="margin-top:6px"></div>
    ${ant ? `<label class="f" style="margin-top:10px">Motivo del cambio *<input id="cc-mot" maxlength="200" placeholder="Ej.: conductor enfermo, cambio de turno, vacaciones"></label>
    <label class="f" style="margin-top:8px">Autorizado por *<select id="cc-aut"><option value="">— Quién lo autorizó —</option>${auts.map(a => `<option ${a === ACTOR ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></label>
    <div class="mini" style="margin-top:4px">Solo pueden autorizar usuarios con el permiso «Cambiar o quitar el conductor». Queda en el historial quién autorizó y quién lo hizo (${esc(ACTOR)}).</div>` : '<div class="mini" style="margin-top:8px">Primera asignación: queda registrada en el historial.</div>'}
    <div class="form-err" id="cc-err" hidden></div>
    <div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn sec" id="cc-x">Cancelar</button><button class="btn" id="cc-ok">${ant ? 'Guardar cambio' : 'Asignar'}</button></div>`);
  const impacto = () => { const n = $('cc-n').value; const en = n && S.vehiculos.find(x => x.conductor === n && x.id !== v.id);
    $('cc-imp').innerHTML = `${n ? `<b>${esc(n)}</b> quedará en el camión ${esc(v.placa)}` : `El camión ${esc(v.placa)} quedará sin conductor`}${abiertas.length ? ` y en sus viajes que no han salido: ${abiertas.map(esc).join(', ')}` : ''}.${en ? ` Se quitará de ${esc(en.placa)}${S.rutas.some(x => x.vehiculo_id === en.id && CC_ABIERTAS.includes(x.estado)) ? ' (sus viajes que no han salido quedarán sin conductor)' : ''}.` : ''}`; };
  $('cc-n').onchange = impacto; impacto();
  $('cc-x').onclick = closeModal;
  $('cc-ok').onclick = async () => {
    const n = $('cc-n').value; if (!n && !(tipo === 'camion' && ant)) return formError('cc-err', 'Elige el conductor.', 'cc-n');
    const motivo = ant ? $('cc-mot').value.trim() : ''; const autorizado = ant ? $('cc-aut').value : '';
    if (ant && motivo.length < 3) return formError('cc-err', 'Escribe el motivo del cambio.', 'cc-mot');
    if (ant && !autorizado) return formError('cc-err', 'Indica quién autorizó el cambio.', 'cc-aut');
    $('cc-ok').disabled = true;
    try { const res = await ccEjecutar({ tipo, id, nombre: n, motivo, autorizado }); closeModal(); toast(ccResumen(res, n)); }
    catch (e) { $('cc-ok').disabled = false; return formError('cc-err', e.message || String(e)); }
    CC.hist = null; await loadAll(); render(); if (S.view === 'conductores') renderConductores();
  };
}

async function renderConductores() {
  const box = $('cc-body'); if (!box) return;
  document.querySelectorAll('#cc-tabs button').forEach(b => { b.classList.toggle('on', b.dataset.t === CC.tab); b.onclick = () => { CC.tab = b.dataset.t; renderConductores(); }; });
  const camb = ccPuedeCambiar();
  $('cc-perm').innerHTML = camb ? '<span class="pill p-ok">Puedes cambiar conductores</span>' : '<span class="pill p-warn">Solo puedes asignar a rutas o camiones sin conductor; cambiar requiere el permiso «Cambiar o quitar el conductor»</span>';
  const btn = (tipo, id, tiene) => (tiene ? camb : ccPuedeAsignar()) ? `<button class="btn ${tiene ? 'sec' : ''} xs" data-cc="${tipo}:${id}">${tiene ? 'Cambiar' : 'Asignar'}</button>` : '<span class="mini">sin permiso</span>';
  if (CC.tab === 'rutas') {
    const rs = S.rutas.filter(r => CC_ABIERTAS.includes(r.estado)).sort((a, b) => (a.fecha || '').localeCompare(b.fecha || '') || a.codigo.localeCompare(b.codigo));
    box.innerHTML = `<div class="tw"><table><thead><tr><th>Fecha</th><th>Ruta · viaje</th><th>Camión</th><th>Conductor</th><th>Ayudante</th><th>Estado</th><th></th></tr></thead><tbody>${rs.map(r => { const v = veh(r.vehiculo_id) || {}; return `<tr><td class="code">${esc(r.fecha || '')}</td><td style="white-space:nowrap"><span class="swatch" style="background:${rutaColor(r)}"></span><b>${esc(r.codigo)}</b> <span class="mini">${esc(rutaColorN(r) || '')} · ${esc(typeof viajeTxt === 'function' ? viajeTxt(r) : '')}</span></td><td class="code">${esc(v.placa || '')}<br><span class="mini">${esc(v.nombre || '')}</span></td><td>${r.conductor ? `<b>${esc(r.conductor)}</b>` : '<span class="pill p-crit">Sin conductor</span>'}</td><td>${esc(r.ayudante || '—')}</td><td>${rpill(r.estado)}${r.estado === 'liberada' ? '<br><span class="mini" style="color:#b9770e">⚠ ya cargado · documentación liberada</span>' : ''}</td><td>${btn('ruta', r.id, !!r.conductor)}</td></tr>`; }).join('') || '<tr><td colspan="7" class="note">No hay viajes por salir (los que ya salieron no cambian de conductor).</td></tr>'}</tbody></table></div>`;
  } else if (CC.tab === 'camiones') {
    const vs = S.vehiculos.filter(v => v.activo !== false).sort((a, b) => (a.placa || '').localeCompare(b.placa || ''));
    box.innerHTML = `<div class="tw"><table><thead><tr><th>Camión</th><th>Tipo</th><th>Conductor</th><th>Ayudante</th><th>Viajes por salir <span class="mini">(⚠ ya cargado)</span></th><th></th></tr></thead><tbody>${vs.map(v => { const ab = S.rutas.filter(r => r.vehiculo_id === v.id && CC_ABIERTAS.includes(r.estado)); return `<tr><td class="code"><b>${esc(v.placa)}</b><br><span class="mini">${esc(v.nombre || '')}</span></td><td>${esc(tipoVeh(v.tipo))}</td><td>${v.conductor ? `<b>${esc(v.conductor)}</b>` : '<span class="pill p-warn">Sin conductor</span>'}</td><td>${esc(v.ayudante || '—')}</td><td class="mini">${ab.map(r => esc(ccFV(r)) + (r.estado === 'liberada' ? ' ⚠' : '')).join(', ') || '—'}</td><td>${btn('camion', v.id, !!v.conductor)}</td></tr>`; }).join('')}</tbody></table></div>`;
  } else {
    if (!CC.hist) { box.innerHTML = '<div class="empty">Cargando historial…</div>'; await ccHistorial(); }
    const f = CC.filtro.toLowerCase(); const H = CC.hist.filter(h => !f || [h.placa, h.ruta_codigo, h.anterior, h.nuevo, h.motivo, h.autorizado_por, h.ejecutado_por].some(x => String(x || '').toLowerCase().includes(f)));
    box.innerHTML = `<div class="row" style="margin-bottom:10px"><input id="cc-f" placeholder="Buscar por camión, ruta, conductor, motivo o usuario" value="${esc(CC.filtro)}" style="flex:1;min-width:260px"><button class="btn sec" id="cc-csv">Exportar CSV</button></div>
      <div class="tw"><table><thead><tr><th>Fecha y hora</th><th>Sobre</th><th>Anterior → nuevo</th><th>Motivo</th><th>Autorizó</th><th>Ejecutó</th><th>Efecto</th></tr></thead><tbody>${H.map(h => `<tr><td class="mini" style="white-space:nowrap">${new Date(h.created_at).toLocaleString('es-PA')}</td><td style="white-space:nowrap">${h.tipo === 'ruta' ? `Ruta <b>${esc(h.ruta_codigo || '')}</b> <span class="mini">${esc(h.ruta_fecha || '')}</span><br>` : ''}<span class="code">${esc(h.placa || '')}</span></td><td>${esc(h.anterior || '—')} → <b>${esc(h.nuevo || 'sin conductor')}</b>${h.es_cambio ? '' : '<br><span class="pill p-info nodot">primera asignación</span>'}</td><td>${esc(h.motivo || '—')}</td><td>${esc(h.autorizado_por || '—')}</td><td>${esc(h.ejecutado_por || '')}</td><td class="mini">${(h.rutas_actualizadas || []).length ? 'viajes ' + esc(h.rutas_actualizadas.join(', ')) : ''}${(h.quitado_de || []).length ? `<br>se quitó de ${esc(h.quitado_de.join(', '))}` : ''}${(h.rutas_sin_conductor || []).length ? `<br>quedaron sin conductor ${esc(h.rutas_sin_conductor.join(', '))}` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="note">Sin cambios registrados.</td></tr>'}</tbody></table></div>`;
    $('cc-f').oninput = e => { CC.filtro = e.target.value; clearTimeout(CC.t); CC.t = setTimeout(() => { renderConductores().then(() => { const i = $('cc-f'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }); }, 250); };
    $('cc-csv').onclick = () => descargarCSV(`cambios_conductor_${hoy()}.csv`, H.map(h => ({ fecha_hora: h.created_at, tipo: h.tipo, ruta: h.ruta_codigo || '', fecha_ruta: h.ruta_fecha || '', camion: h.placa || '', anterior: h.anterior || '', nuevo: h.nuevo || '', primera_asignacion: !h.es_cambio, motivo: h.motivo || '', autorizo: h.autorizado_por || '', ejecuto: h.ejecutado_por || '', viajes_actualizados: (h.rutas_actualizadas || []).join(' '), quitado_de: (h.quitado_de || []).join(' '), quedaron_sin_conductor: (h.rutas_sin_conductor || []).join(' ') })));
  }
  document.querySelectorAll('[data-cc]').forEach(b => b.onclick = () => { const [t, id] = b.dataset.cc.split(':'); ccModal(t, id); });
}
