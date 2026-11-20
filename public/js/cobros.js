/* DGP · Cobros en ruta (torre de control) — 20-nov-2026.
   · Asignar cobros a un viaje: cliente, documento, monto, efectivo o cheque (banco y número obligatorios).
   · El conductor marca Recibido / No recibido (con causa del catálogo «Causas de no cobro») en su app.
   · Al regreso: «Recibir cobros» por viaje con nombre y firma de quien recibe → estado Entregado + acta imprimible.
   Reglas en la base: trigger guardia_cobros, registrar_cobro, liquidar_cobros (cobros-core.js las replica en demo). */
const CB = { rows: null, actas: [], rutasX: {}, f: { estado: 'abiertos', ruta: '', q: '' } };
const CB_ABIERTAS = ['simulada', 'aprobada', 'publicada', 'en_cargue', 'liberada', 'en_ruta'];
const CB_BANCOS = ['Banco General', 'Banistmo', 'BAC Credomatic', 'Banco Nacional de Panamá', 'Caja de Ahorros', 'Global Bank', 'Multibank', 'Scotiabank', 'Banesco', 'Credicorp Bank', 'St. Georges Bank', 'Davivienda', 'Towerbank', 'MetroBank', 'Banisi', 'Bicsa', 'Prival Bank'];
const cbGest = () => puede('cobros.gestionar');
const cbLiq = () => puede('cobros.liquidar');
const cbRuta = id => S.rutas.find(r => r.id === id) || CB.rutasX[id] || null;
const cbRutaTxt = r => r ? `${r.codigo} · ${String(r.fecha || '').slice(8, 10)}/${String(r.fecha || '').slice(5, 7)}` : '—';

async function cbCargar() {
  try { CB.rows = await DB.all('cobros', null, 'created_at', { desc: true, limit: 1500 }); } catch (e) { CB.rows = []; toast('No se pudieron leer los cobros: ' + (e.message || e)); }
  try {
    if (DB.getMode() === 'supabase') { const { data, error } = await DB.client().from('cobros_liquidaciones').select('id,created_at,ruta_id,ruta_codigo,ruta_fecha,conductor,recibe,liquidado_por,n_cobros,total,total_efectivo,total_cheques,n_cheques').order('created_at', { ascending: false }).limit(100); if (error) throw error; CB.actas = data || []; }
    else CB.actas = (await DB.all('cobros_liquidaciones', null, 'created_at', { desc: true, limit: 100 })) || [];
  } catch (e) { CB.actas = []; }
  const falta = [...new Set(CB.rows.map(c => c.ruta_id))].filter(id => !S.rutas.some(r => r.id === id) && !CB.rutasX[id]);
  if (falta.length) { try { (await DB.all('rutas', { id: falta })).forEach(r => CB.rutasX[r.id] = r); } catch (e) { } }
}

async function renderCobros(recargar) {
  const box = $('cb-body'); if (!box) return;
  if (!CB.rows || recargar) { box.innerHTML = '<div class="empty">Cargando cobros…</div>'; await cbCargar(); }
  const R = CB.rows; const f = CB.f; const q = f.q.trim().toLowerCase();
  const filas = R.filter(c => (f.estado === 'todos' || (f.estado === 'abiertos' ? ['pendiente', 'recibido', 'no_recibido'].includes(c.estado) : c.estado === f.estado))
    && (!f.ruta || c.ruta_id === f.ruta) && (!q || [((cli(c.cliente_id) || {}).nombre), ((cli(c.cliente_id) || {}).codigo), c.documento, c.banco, c.numero_cheque, c.conductor, (cbRuta(c.ruta_id) || {}).codigo].some(x => String(x || '').toLowerCase().includes(q))));
  const sum = (arr, k = 'monto') => arr.reduce((s, c) => s + +(c[k] || 0), 0);
  const by = e => R.filter(c => c.estado === e);
  $('cb-kpis').innerHTML = [
    ['Por cobrar en ruta', by('pendiente').length, 'B/. ' + fmt(sum(by('pendiente'))), ''],
    ['Recibido por conductores', by('recibido').length, 'B/. ' + fmt(sum(by('recibido'), 'monto_recibido')) + ' · falta entregar en oficina', by('recibido').length ? 'warn' : ''],
    ['No recibido', by('no_recibido').length, 'B/. ' + fmt(sum(by('no_recibido'))), by('no_recibido').length ? 'crit' : ''],
    ['Entregado en oficina', by('entregado').length, 'B/. ' + fmt(sum(by('entregado'), 'monto_recibido')), 'ok']
  ].map(([t, v, s, cl]) => `<div class="tile" style="${cl ? `border-left:4px solid var(--${cl === 'ok' ? 'brand' : cl})` : ''}"><div class="l">${t}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('');
  // viajes con dinero por entregar en oficina
  const porRuta = {}; by('recibido').forEach(c => (porRuta[c.ruta_id] = porRuta[c.ruta_id] || []).push(c));
  const liq = Object.entries(porRuta).map(([rid, cs]) => { const r = cbRuta(rid) || {}; const ef = cs.filter(c => c.forma === 'efectivo'), ch = cs.filter(c => c.forma === 'cheque');
    return `<div class="row" style="justify-content:space-between;border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:6px 0"><div><b>${esc(cbRutaTxt(r))}</b> <span class="mini">${esc(r.conductor || '')} · ${rpill(r.estado || '')}</span><br><span class="mini">${cs.length} cobro${cs.length === 1 ? '' : 's'} · efectivo B/. ${fmt(sum(ef, 'monto_recibido'))} · ${ch.length} cheque${ch.length === 1 ? '' : 's'} B/. ${fmt(sum(ch, 'monto_recibido'))}</span></div>
      ${cbLiq() ? `<button class="btn" data-cb-liq="${rid}">Recibir B/. ${fmt(sum(cs, 'monto_recibido'))}</button>` : '<span class="mini">requiere permiso «Recibir cobros»</span>'}</div>`; }).join('');
  $('cb-liq').innerHTML = liq ? `<h3 style="margin:0 0 4px">Dinero por entregar en oficina</h3><div class="mini">Cuando regresa el camión, quien recibe el efectivo y los cheques firma y el cobro pasa a «Entregado».</div>${liq}` : '';
  const rutasF = [...new Set(R.map(c => c.ruta_id))].map(cbRuta).filter(Boolean).sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || a.codigo.localeCompare(b.codigo));
  box.innerHTML = `<div class="row" style="margin-bottom:10px;flex-wrap:wrap;gap:8px">
      <select id="cb-fe"><option value="abiertos">Abiertos (pendiente, recibido, no recibido)</option>${Object.entries(CB_EST).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('')}<option value="todos">Todos</option></select>
      <select id="cb-fr"><option value="">Todos los viajes</option>${rutasF.map(r => `<option value="${r.id}">${esc(cbRutaTxt(r))} · ${esc(r.conductor || 'sin conductor')}</option>`).join('')}</select>
      <input id="cb-fq" placeholder="Cliente, documento, banco, cheque o conductor" value="${esc(f.q)}" style="flex:1;min-width:220px">
      <button class="btn sec" id="cb-csv">Exportar CSV</button>${cbGest() ? '<button class="btn" id="cb-nuevo">+ Nuevo cobro</button>' : ''}</div>
    <div class="tw"><table><thead><tr><th>Viaje</th><th>Cliente</th><th>Documento</th><th class="num">Monto</th><th>Forma</th><th>Estado</th><th>Conductor / resultado</th><th></th></tr></thead><tbody>
    ${filas.map(c => { const r = cbRuta(c.ruta_id) || {}; const k = cli(c.cliente_id) || {}; const acc = [];
      if (c.estado === 'pendiente' && cbGest()) acc.push(`<button class="btn sec xs" data-cb-ed="${c.id}">Editar</button>`);
      if (['pendiente', 'recibido', 'no_recibido'].includes(c.estado) && cbGest() && ['en_ruta', 'cerrada'].includes(r.estado)) acc.push(`<button class="btn sec xs" data-cb-reg="${c.id}" title="Registrar el resultado en nombre del conductor">Resultado</button>`);
      if (['pendiente', 'no_recibido'].includes(c.estado) && cbGest()) acc.push(`<button class="btn sec xs" data-cb-an="${c.id}">Anular</button>`);
      if (c.estado === 'entregado' && c.liquidacion_id) acc.push(`<button class="btn sec xs" data-cb-acta="${c.liquidacion_id}">Acta</button>`);
      const res = c.estado === 'recibido' || c.estado === 'entregado' ? `Recibió B/. ${fmt(c.monto_recibido)}${Math.abs(+c.monto_recibido - +c.monto) > 0.004 ? ' <span class="pill p-warn">difiere</span>' : ''}` : c.estado === 'no_recibido' ? esc(c.causa_nombre || '') : c.estado === 'anulado' ? 'Anulado: ' + esc(c.anulado_motivo || '') : '';
      return `<tr><td style="white-space:nowrap"><b>${esc(cbRutaTxt(r))}</b><br><span class="mini">${esc((veh(r.vehiculo_id) || {}).placa || '')} · ${rpill(r.estado || '')}</span></td>
        <td><b>${esc(k.nombre || '—')}</b><br><span class="mini">${esc(k.codigo || '')}</span></td><td class="code">${esc(c.documento || '—')}${c.notas ? `<br><span class="mini">${esc(c.notas)}</span>` : ''}</td>
        <td class="num"><b>${fmt(c.monto)}</b></td><td>${esc(CB_FORMA[c.forma] || c.forma)}${c.forma === 'cheque' ? `<br><span class="mini">${esc(c.banco || '')} nº ${esc(c.numero_cheque || '')}</span>` : ''}</td>
        <td>${cbPill(c.estado)}${c.estado === 'entregado' ? `<br><span class="mini">recibió ${esc(c.entregado_a || '')}</span>` : ''}</td>
        <td class="mini">${esc(c.conductor || r.conductor || '')}${res ? '<br>' + res : ''}${c.nota_conductor ? `<br><i>${esc(c.nota_conductor)}</i>` : ''}${c.gestion_at ? `<br>${new Date(c.gestion_at).toLocaleString('es-PA')}` : ''}</td>
        <td style="white-space:nowrap">${acc.join(' ')}</td></tr>`; }).join('') || '<tr><td colspan="8" class="note">Sin cobros con este filtro.</td></tr>'}
    </tbody></table></div>
    ${CB.actas.length ? `<h3 style="margin:18px 0 6px">Actas de entrega en oficina</h3><div class="tw"><table><thead><tr><th>Fecha</th><th>Viaje</th><th>Entregó</th><th>Recibió</th><th class="num">Cobros</th><th class="num">Efectivo</th><th class="num">Cheques</th><th class="num">Total</th><th></th></tr></thead><tbody>${CB.actas.slice(0, 30).map(a => `<tr><td class="mini">${new Date(a.created_at).toLocaleString('es-PA')}</td><td>${esc(a.ruta_codigo || '')} <span class="mini">${esc(a.ruta_fecha || '')}</span></td><td>${esc(a.conductor || '')}</td><td>${esc(a.recibe)}</td><td class="num">${a.n_cobros}</td><td class="num">${fmt(a.total_efectivo)}</td><td class="num">${fmt(a.total_cheques)} <span class="mini">(${a.n_cheques})</span></td><td class="num"><b>${fmt(a.total)}</b></td><td><button class="btn sec xs" data-cb-acta="${a.id}">Imprimir</button></td></tr>`).join('')}</tbody></table></div>` : ''}`;
  $('cb-fe').value = f.estado; $('cb-fr').value = f.ruta;
  $('cb-fe').onchange = e => { f.estado = e.target.value; renderCobros(); };
  $('cb-fr').onchange = e => { f.ruta = e.target.value; renderCobros(); };
  $('cb-fq').oninput = e => { f.q = e.target.value; clearTimeout(CB.t); CB.t = setTimeout(() => renderCobros().then(() => { const i = $('cb-fq'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }), 250); };
  $('cb-csv').onclick = () => descargarCSV(`cobros_${hoy()}.csv`, filas.map(c => { const r = cbRuta(c.ruta_id) || {}; const k = cli(c.cliente_id) || {}; return { viaje: r.codigo || '', fecha_viaje: r.fecha || '', camion: (veh(r.vehiculo_id) || {}).placa || '', cliente_codigo: k.codigo || '', cliente: k.nombre || '', documento: c.documento || '', monto: c.monto, forma: c.forma, banco: c.banco || '', numero_cheque: c.numero_cheque || '', estado: c.estado, conductor: c.conductor || r.conductor || '', monto_recibido: c.monto_recibido ?? '', causa_no_cobro: c.causa_nombre || '', nota_conductor: c.nota_conductor || '', gestion: c.gestion_at || '', entregado_a: c.entregado_a || '', entregado: c.entregado_at || '', creado_por: c.creado_por || '', creado: c.created_at, anulado_motivo: c.anulado_motivo || '' }; }));
  if ($('cb-nuevo')) $('cb-nuevo').onclick = () => cbEditar(null);
  document.querySelectorAll('[data-cb-ed]').forEach(b => b.onclick = () => cbEditar(b.dataset.cbEd));
  document.querySelectorAll('[data-cb-an]').forEach(b => b.onclick = () => cbAnular(b.dataset.cbAn));
  document.querySelectorAll('[data-cb-reg]').forEach(b => b.onclick = () => cbResultado(b.dataset.cbReg));
  document.querySelectorAll('[data-cb-liq]').forEach(b => b.onclick = () => cbLiquidar(b.dataset.cbLiq));
  document.querySelectorAll('[data-cb-acta]').forEach(b => b.onclick = () => cbImprimirActa(b.dataset.cbActa));
}

/* Alta / edición (solo pendientes). */
function cbEditar(id, ridPreset) {
  if (!exige('cobros.gestionar')) return;
  const c = id ? CB.rows.find(x => x.id === id) : null; if (id && (!c || c.estado !== 'pendiente')) return toast('Solo se editan cobros pendientes');
  const rutas = S.rutas.filter(r => CB_ABIERTAS.includes(r.estado) || (c && r.id === c.ruta_id)).sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || a.codigo.localeCompare(b.codigo));
  if (!rutas.length) return toast('No hay viajes abiertos a los que asignar un cobro');
  const cliTxt = k => k ? `${k.codigo} · ${k.nombre}` : '';
  modal(`<h2 style="margin-bottom:4px">${c ? 'Editar cobro' : 'Nuevo cobro en ruta'}</h2><p class="mini" style="margin-top:0">El conductor lo verá en su app y marcará si lo recibió. Al regreso se entrega en oficina con firma.</p>
    <div class="grid g2" style="gap:10px">
      <label class="mini" style="grid-column:1/-1">Viaje *<select id="cb-r" style="width:100%">${rutas.map(r => `<option value="${r.id}">${esc(cbRutaTxt(r))} · ${esc((veh(r.vehiculo_id) || {}).placa || '')} · ${esc(r.conductor || 'sin conductor')} · ${esc(r.estado)}</option>`).join('')}</select></label>
      <label class="mini" style="grid-column:1/-1">Cliente * <span id="cb-cli-n"></span><input id="cb-cli" list="cb-cli-l" placeholder="Escribe el código o el nombre" style="width:100%" autocomplete="off"><datalist id="cb-cli-l"></datalist></label>
      <label class="mini">Factura del viaje (opcional)<select id="cb-p" style="width:100%"></select></label>
      <label class="mini">Documento / referencia<input id="cb-doc" maxlength="80" placeholder="Factura(s) o estado de cuenta" style="width:100%"></label>
      <label class="mini">Monto B/. *<input id="cb-m" type="number" min="0.01" step="0.01" style="width:100%"></label>
      <label class="mini">Forma de pago *<select id="cb-fo" style="width:100%"><option value="efectivo">Efectivo</option><option value="cheque">Cheque</option></select></label>
      <label class="mini cb-ch">Banco *<input id="cb-b" list="cb-b-l" maxlength="60" style="width:100%"><datalist id="cb-b-l">${CB_BANCOS.map(b => `<option value="${esc(b)}">`).join('')}</datalist></label>
      <label class="mini cb-ch">Número de cheque *<input id="cb-n" maxlength="30" style="width:100%;font-family:var(--mono)"></label>
      <label class="mini" style="grid-column:1/-1">Notas para el conductor<input id="cb-no" maxlength="200" placeholder="Ej.: pedir a la Sra. Pérez en administración" style="width:100%"></label>
    </div><div class="form-err" id="cb-err" hidden></div>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn sec" onclick="closeModal()">Cancelar</button><button class="btn" id="cb-ok">${c ? 'Guardar' : 'Asignar cobro'}</button></div>`);
  const clientesDe = rid => { const ids = [...new Set(S.pedidos.filter(p => p.ruta_id === rid).map(p => p.cliente_id))]; return ids.map(cli).filter(Boolean); };
  const pintarClientes = () => { const rid = $('cb-r').value; const delViaje = clientesDe(rid); const set = new Set(delViaje.map(k => k.id));
    $('cb-cli-l').innerHTML = delViaje.map(k => `<option value="${esc(cliTxt(k))}">★ en este viaje</option>`).join('') + S.clientes.filter(k => !set.has(k.id)).slice(0, 4000).map(k => `<option value="${esc(cliTxt(k))}">`).join(''); };
  const cliSel = () => { const v = $('cb-cli').value.trim(); return S.clientes.find(k => cliTxt(k) === v) || S.clientes.find(k => k.codigo === v) || null; };
  const pintarPedidos = () => { const k = cliSel(); const rid = $('cb-r').value; $('cb-cli-n').innerHTML = k ? `<span class="pill p-ok nodot">${esc(k.nombre)}</span>` : '';
    const ps = k ? S.pedidos.filter(p => p.cliente_id === k.id).sort((a, b) => (b.ruta_id === rid) - (a.ruta_id === rid)) : [];
    $('cb-p').innerHTML = '<option value="">— Sin factura específica —</option>' + ps.map(p => `<option value="${p.id}">${esc(p.numero_factura || p.numero_so)} · B/. ${fmt(p.valor)}${p.ruta_id === rid ? ' · en este viaje' : ''}</option>`).join(''); };
  const pintarForma = () => document.querySelectorAll('.cb-ch').forEach(x => x.style.display = $('cb-fo').value === 'cheque' ? '' : 'none');
  $('cb-r').onchange = () => { pintarClientes(); pintarPedidos(); }; $('cb-cli').oninput = pintarPedidos; $('cb-fo').onchange = pintarForma;
  $('cb-p').onchange = () => { const p = S.pedidos.find(x => x.id === $('cb-p').value); if (!p) return; if (!$('cb-doc').value.trim()) $('cb-doc').value = p.numero_factura || p.numero_so || ''; if (!$('cb-m').value) $('cb-m').value = (+p.valor || 0).toFixed(2); };
  if (c) { $('cb-r').value = c.ruta_id; pintarClientes(); $('cb-cli').value = cliTxt(cli(c.cliente_id)); pintarPedidos(); $('cb-p').value = c.pedido_id || ''; $('cb-doc').value = c.documento || ''; $('cb-m').value = c.monto; $('cb-fo').value = c.forma; $('cb-b').value = c.banco || ''; $('cb-n').value = c.numero_cheque || ''; $('cb-no').value = c.notas || ''; }
  else { if (ridPreset && rutas.some(r => r.id === ridPreset)) $('cb-r').value = ridPreset; pintarClientes(); pintarPedidos(); }
  pintarForma();
  $('cb-ok').onclick = async () => {
    document.querySelectorAll('.campo-error').forEach(x => x.classList.remove('campo-error'));
    const k = cliSel(); if (!k) return formError('cb-err', 'Elige el cliente de la lista.', 'cb-cli');
    const m = Math.round(+$('cb-m').value * 100) / 100; if (!(m > 0)) return formError('cb-err', 'Escribe el monto a cobrar (mayor que cero).', 'cb-m');
    const forma = $('cb-fo').value; const banco = $('cb-b').value.trim(), num = $('cb-n').value.trim();
    if (forma === 'cheque' && !banco) return formError('cb-err', 'Un cheque debe tener el banco.', 'cb-b');
    if (forma === 'cheque' && !num) return formError('cb-err', 'Un cheque debe tener el número de cheque.', 'cb-n');
    const row = { ruta_id: $('cb-r').value, cliente_id: k.id, pedido_id: $('cb-p').value || null, documento: $('cb-doc').value.trim() || null, monto: m, forma, banco: forma === 'cheque' ? banco : null, numero_cheque: forma === 'cheque' ? num : null, notas: $('cb-no').value.trim() || null };
    const dup = CB.rows.find(x => x.id !== (c && c.id) && x.ruta_id === row.ruta_id && x.cliente_id === row.cliente_id && x.estado === 'pendiente' && Math.abs(+x.monto - m) < 0.005 && (x.documento || '') === (row.documento || ''));
    if (dup && !confirm('Ya hay un cobro pendiente igual (mismo viaje, cliente, documento y monto). ¿Crear otro?')) return;
    $('cb-ok').disabled = true;
    try {
      if (c) { const r = await DB.update('cobros', { id: c.id }, row); if (DB.getMode() === 'supabase' && (!r || !r.length)) throw new Error('la base no aceptó el cambio (revisa permisos)'); await DB.audit('cobros', 'cobro_editado', `${cbRutaTxt(cbRuta(row.ruta_id))} · ${k.nombre} · B/. ${fmt(m)} ${cbForma(row)}`, ACTOR, false, c.id); }
      else { const nid = DB.uuid(); await DB.insert('cobros', [Object.assign({ id: nid, estado: 'pendiente', creado_por: ACTOR, created_at: new Date().toISOString() }, row)]); await DB.audit('cobros', 'cobro_asignado', `${cbRutaTxt(cbRuta(row.ruta_id))} · ${k.nombre} · ${row.documento || 's/doc'} · B/. ${fmt(m)} ${cbForma(row)}`, ACTOR, false, nid); }
    } catch (e) { $('cb-ok').disabled = false; return formError('cb-err', 'No se pudo guardar: ' + (e.message || e)); }
    closeModal(); toast(c ? 'Cobro actualizado' : `Cobro asignado al viaje ${cbRutaTxt(cbRuta(row.ruta_id))}`); await renderCobros(true); if (typeof refrescarVerifCobros === 'function') refrescarVerifCobros();
  };
}

function cbAnular(id) {
  if (!exige('cobros.gestionar')) return; const c = CB.rows.find(x => x.id === id); if (!c) return;
  modal(`<h2>Anular cobro</h2><p class="mini">${esc((cli(c.cliente_id) || {}).nombre || '')} · ${esc(c.documento || '')} · B/. ${fmt(c.monto)} ${esc(cbForma(c))}</p>
    <label class="mini">Motivo *<input id="cb-am" maxlength="200" placeholder="Ej.: el cliente pagó por transferencia" style="width:100%"></label><div class="form-err" id="cb-err" hidden></div>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn sec" onclick="closeModal()">Cancelar</button><button class="btn crit" id="cb-ok">Anular cobro</button></div>`);
  $('cb-ok').onclick = async () => { const mo = $('cb-am').value.trim(); if (mo.length < 3) return formError('cb-err', 'Escribe el motivo de la anulación.', 'cb-am');
    try { const r = await DB.update('cobros', { id }, { estado: 'anulado', anulado_motivo: mo }); if (DB.getMode() === 'supabase' && (!r || !r.length)) throw new Error('la base no aceptó el cambio'); await DB.audit('cobros', 'cobro_anulado', `B/. ${fmt(c.monto)} · motivo: ${mo}`, ACTOR, false, id); }
    catch (e) { return formError('cb-err', 'No se pudo anular: ' + (e.message || e)); }
    closeModal(); toast('Cobro anulado'); await renderCobros(true); if (typeof refrescarVerifCobros === 'function') refrescarVerifCobros(); };
}

/* La oficina registra el resultado en nombre del conductor (p. ej., sin app o sin señal). */
function cbResultado(id) {
  const c = CB.rows.find(x => x.id === id); if (!c) return; const r = cbRuta(c.ruta_id) || {};
  const causas = cbCausas(S.causasCobro);
  modal(`<h2>Resultado del cobro</h2><p class="mini">${esc((cli(c.cliente_id) || {}).nombre || '')} · ${esc(c.documento || '')} · <b>B/. ${fmt(c.monto)}</b> ${esc(cbForma(c))} · viaje ${esc(cbRutaTxt(r))} (${esc(r.conductor || '')})</p>
    <div class="row" style="gap:16px"><label><input type="radio" name="cb-rs" value="1" checked> Recibido</label><label><input type="radio" name="cb-rs" value="0"> No recibido</label></div>
    <div id="cb-rs-si"><label class="mini">Monto recibido B/.<input id="cb-mr" type="number" step="0.01" min="0.01" value="${(+(c.monto_recibido || c.monto)).toFixed(2)}" style="width:100%"></label></div>
    <div id="cb-rs-no" hidden><label class="mini">Causa *<select id="cb-ca" style="width:100%"><option value="">— Elegir —</option>${causas.map(x => `<option value="${esc(x.codigo)}">${esc(x.nombre)}${x.requiere_nota ? ' (requiere nota)' : ''}</option>`).join('')}</select></label></div>
    <label class="mini">Nota<input id="cb-nt" maxlength="200" style="width:100%" placeholder="Obligatoria si el monto difiere o la causa la pide"></label>
    <p class="mini">Queda registrado que lo hizo ${esc(ACTOR)} en nombre del conductor.</p><div class="form-err" id="cb-err" hidden></div>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn sec" onclick="closeModal()">Cancelar</button><button class="btn" id="cb-ok">Guardar</button></div>`);
  document.querySelectorAll('[name=cb-rs]').forEach(x => x.onchange = () => { const si = document.querySelector('[name=cb-rs]:checked').value === '1'; $('cb-rs-si').hidden = !si; $('cb-rs-no').hidden = si; });
  $('cb-ok').onclick = async () => {
    const si = document.querySelector('[name=cb-rs]:checked').value === '1'; const nota = $('cb-nt').value.trim();
    const a = { recibido: si, monto_recibido: si ? Math.round(+$('cb-mr').value * 100) / 100 : null, causa: si ? null : $('cb-ca').value, nota: (nota ? nota + ' · ' : '') + `registrado por ${ACTOR}` };
    if (!si && !a.causa) return formError('cb-err', 'Elige la causa.', 'cb-ca');
    try { if (DB.getMode() === 'supabase') await DB.rpc('registrar_cobro', { cid: c.id, recibido: a.recibido, monto_recibido: a.monto_recibido, causa: a.causa, nota: a.nota }); else await cbRegistrarLocal(c, r, a, S.causasCobro, ACTOR); }
    catch (e) { return formError('cb-err', e.message || String(e)); }
    closeModal(); toast(si ? 'Cobro marcado como recibido' : 'Cobro marcado como no recibido'); renderCobros(true);
  };
}

/* Regreso del camión: quien recibe el dinero firma → Entregado + acta. */
function cbLiquidar(rid) {
  if (!exige('cobros.liquidar')) return; const r = cbRuta(rid) || {}; const cs = CB.rows.filter(c => c.ruta_id === rid && c.estado === 'recibido'); if (!cs.length) return toast('Este viaje no tiene cobros recibidos por entregar');
  modal(`<div class="hd"><div><h2>Recibir cobros del viaje ${esc(cbRutaTxt(r))}</h2><div class="mini">Entrega: <b>${esc(r.conductor || cs[0].conductor || '—')}</b> · ${esc((veh(r.vehiculo_id) || {}).placa || '')}</div></div></div>
    <div class="tw" style="max-height:38vh;overflow:auto"><table><thead><tr><th><input type="checkbox" id="cb-all" checked></th><th>Cliente</th><th>Documento</th><th>Forma</th><th class="num">A cobrar</th><th class="num">Recibido</th></tr></thead><tbody>${cs.map(c => `<tr><td><input type="checkbox" data-cb-x="${c.id}" checked></td><td>${esc((cli(c.cliente_id) || {}).nombre || '')}</td><td class="code">${esc(c.documento || '')}</td><td>${esc(cbForma(c))}</td><td class="num">${fmt(c.monto)}</td><td class="num"><b>${fmt(c.monto_recibido)}</b>${c.nota_conductor ? `<br><span class="mini">${esc(c.nota_conductor)}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>
    <div id="cb-tot" style="margin:8px 0;font-weight:600"></div>
    <label class="mini">Recibe (nombre de quien recibe el dinero) *<input id="cb-rec" maxlength="80" value="${esc(ACTOR)}" style="width:100%"></label>
    <label class="mini" style="display:block;margin-top:8px">Firma de quien recibe * <a href="#" id="cb-fl" style="float:right">Limpiar</a></label>
    <canvas id="cb-fi" style="width:100%;height:150px;border:1px dashed #94A3B8;border-radius:10px;background:#fff;display:block"></canvas>
    <p class="mini">Confirma que contaste el efectivo y revisaste los cheques (banco, número, monto, fecha y beneficiario) antes de firmar.</p>
    <div class="form-err" id="cb-err" hidden></div>
    <div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn sec" onclick="closeModal()">Cancelar</button><button class="btn" id="cb-ok">Confirmar entrega e imprimir acta</button></div>`);
  $('modal-body').classList.add('wide');
  const fir = cbFirma($('cb-fi')); $('cb-fl').onclick = e => { e.preventDefault(); fir.limpiar(); };
  const sel = () => cs.filter(c => document.querySelector(`[data-cb-x="${c.id}"]`).checked);
  const tot = () => { const s = sel(); const ef = s.filter(c => c.forma === 'efectivo').reduce((a, c) => a + +c.monto_recibido, 0), ch = s.filter(c => c.forma === 'cheque'); $('cb-tot').textContent = `${s.length} cobros · efectivo B/. ${fmt(ef)} · ${ch.length} cheques B/. ${fmt(ch.reduce((a, c) => a + +c.monto_recibido, 0))} · total B/. ${fmt(ef + ch.reduce((a, c) => a + +c.monto_recibido, 0))}`; };
  document.querySelectorAll('[data-cb-x]').forEach(x => x.onchange = tot); $('cb-all').onchange = e => { document.querySelectorAll('[data-cb-x]').forEach(x => x.checked = e.target.checked); tot(); }; tot();
  $('cb-ok').onclick = async () => {
    const s = sel(); if (!s.length) return formError('cb-err', 'Marca los cobros que se entregan.');
    const rec = $('cb-rec').value.trim(); if (rec.length < 3) return formError('cb-err', 'Escribe el nombre de quien recibe el dinero.', 'cb-rec');
    const firma = fir.get(); if (!firma) return formError('cb-err', 'Falta la firma de quien recibe.', 'cb-fi');
    $('cb-ok').disabled = true; let res;
    try { res = DB.getMode() === 'supabase' ? await DB.rpc('liquidar_cobros', { ids: s.map(c => c.id), recibe: rec, firma }) : await cbLiquidarLocal(s, r, rec, firma, ACTOR); }
    catch (e) { $('cb-ok').disabled = false; return formError('cb-err', e.message || String(e)); }
    closeModal(); toast(`${res.entregados} cobros entregados · B/. ${fmt(res.total)}`); await renderCobros(true); cbImprimirActa(res.acta, firma);
  };
}

async function cbImprimirActa(aid, firmaLocal) {
  let a = CB.actas.find(x => x.id === aid); let firma = firmaLocal || (a && a.firma);
  try { if (DB.getMode() === 'supabase' && (!a || !firma)) { const { data, error } = await DB.client().from('cobros_liquidaciones').select('*').eq('id', aid).single(); if (error) throw error; a = data; firma = data.firma; } } catch (e) { return toast('No se pudo leer el acta: ' + (e.message || e)); }
  if (!a) return toast('Acta no encontrada');
  const cs = CB.rows.filter(c => c.liquidacion_id === aid); const r = cbRuta(a.ruta_id) || {};
  imprimir(`<div class="pp"><h2 style="margin:0">DGP · Acta de entrega de cobros en ruta</h2>
    <div class="meta"><b>Viaje</b><span>${esc(a.ruta_codigo || r.codigo || '')} · ${esc(a.ruta_fecha || r.fecha || '')} · ${esc((veh(r.vehiculo_id) || {}).placa || '')}</span><b>Fecha y hora</b><span>${new Date(a.created_at).toLocaleString('es-PA')}</span><b>Entrega (conductor)</b><span>${esc(a.conductor || '')}</span><b>Recibe</b><span>${esc(a.recibe)}</span><b>Registró</b><span>${esc(a.liquidado_por || '')}</span></div>
    <table><thead><tr><th>Cliente</th><th>Documento</th><th>Forma</th><th>Banco</th><th>Nº cheque</th><th class="num">A cobrar</th><th class="num">Recibido</th></tr></thead><tbody>${cs.map(c => `<tr><td>${esc((cli(c.cliente_id) || {}).nombre || '')}</td><td>${esc(c.documento || '')}</td><td>${esc(CB_FORMA[c.forma])}</td><td>${esc(c.banco || '')}</td><td>${esc(c.numero_cheque || '')}</td><td class="num">${fmt(c.monto)}</td><td class="num">${fmt(c.monto_recibido)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="6"><b>Efectivo</b></td><td class="num"><b>${fmt(a.total_efectivo)}</b></td></tr><tr><td colspan="6"><b>Cheques (${a.n_cheques})</b></td><td class="num"><b>${fmt(a.total_cheques)}</b></td></tr><tr><td colspan="6"><b>Total entregado</b></td><td class="num"><b>B/. ${fmt(a.total)}</b></td></tr></tfoot></table>
    <div class="firmas"><div>Entrega: ${esc(a.conductor || '')}</div><div>${firma ? `<img src="${firma}" style="height:70px;display:block;margin:0 auto">` : ''}Recibe: ${esc(a.recibe)}</div></div></div>`);
}

// ===================== CATÁLOGO → CAUSAS DE NO COBRO =====================
const cbCausasCat = () => (S.causasCobro && S.causasCobro.length ? S.causasCobro : []).slice().sort((a, b) => (b.activa !== false) - (a.activa !== false) || (a.orden ?? 99) - (b.orden ?? 99) || a.nombre.localeCompare(b.nombre));
function renderCausasCobroCat() {
  const ed = puede('catalogo.editar'); const lista = cbCausasCat();
  $('cat-table').querySelector('thead').innerHTML = '<tr><th>Código</th><th>Causa</th><th>Requiere nota</th><th class="num">Orden</th><th>Estado</th><th></th></tr>';
  $('cat-table').querySelector('tbody').innerHTML = lista.map(c => `<tr style="${c.activa === false ? 'opacity:.55' : ''}"><td class="code"><b>${esc(c.codigo)}</b></td><td>${esc(c.nombre)}</td><td>${c.requiere_nota ? '<span class="pill p-warn">Sí</span>' : 'No'}</td><td class="num">${c.orden ?? ''}</td><td>${c.activa === false ? '<span class="pill p-mut">Inactiva</span>' : '<span class="pill p-ok">Activa</span>'}</td><td>${ed ? `<button class="btn sec sm" data-cnc-ed="${esc(c.codigo)}">Editar</button>` : ''}</td></tr>`).join('')
    || `<tr><td colspan="6" class="empty">El catálogo está vacío: la app usa las causas de fábrica (${CB_CAUSAS_DEF.length}). ${ed ? 'Crea la primera con «+ Nueva causa».' : ''}</td></tr>`;
  $('cat-note').innerHTML = `Causas que elige el conductor cuando <b>no recibe</b> un cobro (efectivo o cheque) en su viaje. No se borran: se desactivan. ${ed ? '<button class="btn sm" id="b-cnc-nueva">+ Nueva causa</button>' : ''}`;
  if ($('b-cnc-nueva')) $('b-cnc-nueva').onclick = () => editarCausaCobro(null);
  document.querySelectorAll('[data-cnc-ed]').forEach(b => b.onclick = () => editarCausaCobro(b.dataset.cncEd));
  $('templates').innerHTML = '';
}
function editarCausaCobro(codigo) {
  if (!exige('catalogo.editar')) return; const L = S.causasCobro || [];
  const nueva = !codigo; const c = nueva ? { codigo: '', nombre: '', requiere_nota: false, orden: Math.max(0, ...L.filter(x => (x.orden ?? 0) < 90).map(x => +x.orden || 0)) + 1, activa: true } : L.find(x => x.codigo === codigo);
  if (!c) return;
  modal(`<h2 style="margin-bottom:4px">${nueva ? 'Nueva causa de no cobro' : 'Causa ' + esc(c.codigo)}</h2><p class="mini" style="margin-top:0">Aparece en la app del conductor al marcar «No recibido».</p>
   <div class="grid g2" style="gap:10px">
    <label class="mini" style="grid-column:1/-1">Causa *<input id="cn-nombre" value="${esc(c.nombre)}" maxlength="120" placeholder="Ej.: Cliente en inventario, no atiende pagos" style="width:100%"></label>
    <label class="mini">Código${nueva ? ' (se genera del texto si lo dejas vacío)' : ' (no se cambia)'}<input id="cn-codigo" value="${esc(c.codigo)}" ${nueva ? '' : 'disabled'} style="width:100%;font-family:var(--mono)"></label>
    <label class="mini">Orden<input id="cn-orden" type="number" min="0" step="1" value="${c.orden ?? ''}" style="width:100%"></label>
    <label class="mini"><input type="checkbox" id="cn-nota" ${c.requiere_nota ? 'checked' : ''}> Requiere nota del conductor</label>
    <label class="mini">Estado<select id="cn-activa" style="width:100%"><option value="1" ${c.activa !== false ? 'selected' : ''}>Activa</option><option value="0" ${c.activa === false ? 'selected' : ''}>Inactiva</option></select></label>
   </div><div class="form-err" id="cn-err" hidden></div>
   <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn sec" onclick="closeModal()">Cancelar</button><button class="btn" id="cn-ok">Guardar</button></div>`);
  $('cn-ok').onclick = async () => {
    const nombre = $('cn-nombre').value.trim(); if (nombre.length < 3) return formError('cn-err', 'Escribe la causa (mínimo 3 caracteres).', 'cn-nombre');
    const slug = t => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
    const cod = nueva ? (slug($('cn-codigo').value.trim()) || slug(nombre)) : c.codigo;
    if (!/^[a-z0-9_]{1,30}$/.test(cod)) return formError('cn-err', 'Código no válido.', 'cn-codigo');
    if (nueva && L.some(x => x.codigo === cod)) return formError('cn-err', `Ya existe la causa ${cod}.`, 'cn-codigo');
    if (L.some(x => x.codigo !== cod && x.nombre.trim().toLowerCase() === nombre.toLowerCase())) return formError('cn-err', 'Ya existe una causa con ese texto.', 'cn-nombre');
    const nv = { nombre, requiere_nota: $('cn-nota').checked, orden: $('cn-orden').value === '' ? null : Math.round(+$('cn-orden').value), activa: $('cn-activa').value === '1', updated_at: new Date().toISOString() };
    try {
      if (nueva) { await DB.insert('causas_no_cobro', [Object.assign({ codigo: cod }, nv)]); await DB.audit('causas_no_cobro', 'alta', `${cod} · ${nombre}`, ACTOR, false); }
      else { const r = await DB.update('causas_no_cobro', { codigo: cod }, nv); if (DB.getMode() === 'supabase' && (!r || !r.length)) throw new Error('la base no aceptó el cambio'); await DB.audit('causas_no_cobro', 'cambio', `${cod}: ${nombre}${nv.activa ? '' : ' (inactiva)'}`, ACTOR, false); }
    } catch (e) { return formError('cn-err', 'No se pudo guardar: ' + (e.message || e)); }
    closeModal(); toast(nueva ? 'Causa creada' : 'Causa actualizada'); await loadAll(); render();
  };
}
