/* DGP · Catálogo → «Causas de entrega» y «Tipos de incidente» (20-nov-2026).
   Agregar, editar y quitar (desactivar). No se borran: las entregas e incidentes ya registrados guardan su texto. */
const CATX = {
  causas_entrega: {
    estado: 'causasEntrega', def: () => CE_DEF, singular: 'causa de entrega',
    nota: 'Causas que ve el conductor al marcar una entrega <b>parcial</b> o <b>no entregada</b>. Al pulsar «Parcial» solo salen las que aplican a parcial (y a ambas); al pulsar «No entregada», las de no entregada (y ambas).',
    extras: [{ k: 'aplica', label: 'Aplica a', ops: [['parcial', 'Entrega parcial'], ['no_entrega', 'No entregada'], ['ambas', 'Ambas']], def: 'parcial' }]
  },
  tipos_incidente: {
    estado: 'tiposIncidente', def: () => TI_DEF, singular: 'tipo de incidente',
    nota: 'Tipos que elige el conductor al pulsar «Incidente» en su app. La severidad y «Avisar a» deciden la alerta que recibe la torre.',
    extras: [{ k: 'severidad', label: 'Severidad', ops: [['baja', 'Baja'], ['media', 'Media'], ['alta', 'Alta']], def: 'media' },
             { k: 'avisar_a', label: 'Avisar a', ops: [['Operaciones', 'Operaciones'], ['Mantenimiento', 'Mantenimiento'], ['Gerencia de operaciones', 'Gerencia de operaciones']], def: 'Operaciones' }]
  }
};
const catxFilas = t => (S[CATX[t].estado] || []).slice().sort((a, b) => (b.activa !== false) - (a.activa !== false) || catOrden(a, b));
const catxBuscar = (t, codigo) => (S[CATX[t].estado] && S[CATX[t].estado].length ? S[CATX[t].estado] : CATX[t].def()).find(x => x.codigo === codigo);
const catxOp = (ex, v) => ((ex.ops.find(o => o[0] === v) || [])[1]) || v || '';

function renderCatX(t) {
  const cfg = CATX[t]; const ed = puede('catalogo.editar'); const L = catxFilas(t);
  $('cat-table').querySelector('thead').innerHTML = `<tr><th>Código</th><th>Nombre</th>${cfg.extras.map(x => `<th>${x.label}</th>`).join('')}<th>Requiere nota</th><th class="num">Orden</th><th>Estado</th><th></th></tr>`;
  $('cat-table').querySelector('tbody').innerHTML = L.map(c => `<tr style="${c.activa === false ? 'opacity:.55' : ''}"><td class="code"><b>${esc(c.codigo)}</b></td><td>${esc(c.nombre)}</td>${cfg.extras.map(x => `<td>${x.k === 'severidad' ? `<span class="pill ${c[x.k] === 'alta' ? 'p-crit' : c[x.k] === 'baja' ? 'p-mut' : 'p-warn'}">${esc(catxOp(x, c[x.k]))}</span>` : esc(catxOp(x, c[x.k]))}</td>`).join('')}<td>${c.requiere_nota ? '<span class="pill p-warn">Sí</span>' : 'No'}</td><td class="num">${c.orden ?? ''}</td><td>${c.activa === false ? '<span class="pill p-mut">Quitada</span>' : '<span class="pill p-ok">Activa</span>'}</td>
    <td style="white-space:nowrap">${ed ? `<button class="btn sec sm" data-cx-ed="${esc(c.codigo)}">Editar</button> <button class="btn sec sm" data-cx-tg="${esc(c.codigo)}">${c.activa === false ? 'Volver a activar' : 'Quitar'}</button>` : ''}</td></tr>`).join('')
    || `<tr><td colspan="${5 + cfg.extras.length}" class="empty">El catálogo está vacío: la app usa los ${cfg.def().length} valores de fábrica. ${ed ? '<button class="btn sm" id="cx-fab">Cargar los valores de fábrica</button>' : ''}</td></tr>`;
  $('cat-note').innerHTML = `${cfg.nota} «Quitar» la saca de la app sin borrar el historial. ${ed ? `<button class="btn sm" id="cx-nueva">+ Nueva ${cfg.singular}</button>` : ''}`;
  if ($('cx-nueva')) $('cx-nueva').onclick = () => editarCatX(t, null);
  if ($('cx-fab')) $('cx-fab').onclick = async () => { try { await DB.insert(t, cfg.def().map(x => Object.assign({}, x))); await DB.audit(t, 'alta', `Valores de fábrica (${cfg.def().length})`, ACTOR, false); } catch (e) { return toast('No se pudo cargar: ' + (e.message || e)); } await loadAll(); render(); };
  document.querySelectorAll('[data-cx-ed]').forEach(b => b.onclick = () => editarCatX(t, b.dataset.cxEd));
  document.querySelectorAll('[data-cx-tg]').forEach(b => b.onclick = async () => {
    if (!exige('catalogo.editar')) return; const c = L.find(x => x.codigo === b.dataset.cxTg); if (!c) return; const nv = c.activa === false;
    if (!nv && L.filter(x => x.activa !== false && (t !== 'causas_entrega' || x.aplica === c.aplica || x.aplica === 'ambas' || c.aplica === 'ambas')).length <= 1) return toast('No puedes quitar la última: el conductor se quedaría sin opciones');
    try { const r = await DB.update(t, { codigo: c.codigo }, { activa: nv, updated_at: new Date().toISOString() }); if (DB.getMode() === 'supabase' && (!r || !r.length)) throw new Error('la base no aceptó el cambio'); await DB.audit(t, nv ? 'activada' : 'quitada', `${c.codigo} · ${c.nombre}`, ACTOR, false); }
    catch (e) { return toast('No se pudo cambiar: ' + (e.message || e)); }
    toast(nv ? 'Activada de nuevo' : 'Quitada de la app'); await loadAll(); render();
  });
  $('templates').innerHTML = '';
}

function editarCatX(t, codigo) {
  if (!exige('catalogo.editar')) return; const cfg = CATX[t]; const L = S[cfg.estado] || [];
  const nueva = !codigo; const c = nueva ? Object.assign({ codigo: '', nombre: '', requiere_nota: false, orden: Math.max(0, ...L.filter(x => (x.orden ?? 0) < 90).map(x => +x.orden || 0)) + 1, activa: true }, Object.fromEntries(cfg.extras.map(x => [x.k, x.def]))) : L.find(x => x.codigo === codigo);
  if (!c) return;
  modal(`<h2 style="margin-bottom:4px">${nueva ? 'Nueva ' + cfg.singular : esc(c.nombre)}</h2>
   <div class="grid g2" style="gap:10px">
    <label class="mini" style="grid-column:1/-1">Nombre (lo que ve el conductor) *<input id="cx-nombre" value="${esc(c.nombre)}" maxlength="120" style="width:100%"></label>
    ${cfg.extras.map(x => `<label class="mini">${x.label}<select id="cx-${x.k}" style="width:100%">${x.ops.map(o => `<option value="${esc(o[0])}" ${c[x.k] === o[0] ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select></label>`).join('')}
    <label class="mini">Código${nueva ? ' (se genera del nombre si lo dejas vacío)' : ' (no se cambia)'}<input id="cx-codigo" value="${esc(c.codigo)}" ${nueva ? '' : 'disabled'} style="width:100%;font-family:var(--mono)"></label>
    <label class="mini">Orden en la lista<input id="cx-orden" type="number" min="0" step="1" value="${c.orden ?? ''}" style="width:100%"></label>
    <label class="mini"><input type="checkbox" id="cx-nota" ${c.requiere_nota ? 'checked' : ''}> El conductor debe escribir una nota</label>
   </div><div class="form-err" id="cx-err" hidden></div>
   <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn sec" onclick="closeModal()">Cancelar</button><button class="btn" id="cx-ok">Guardar</button></div>`);
  $('cx-ok').onclick = async () => {
    const nombre = $('cx-nombre').value.trim(); if (nombre.length < 3) return formError('cx-err', 'Escribe el nombre (mínimo 3 caracteres).', 'cx-nombre');
    const slug = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
    const cod = nueva ? (slug($('cx-codigo').value.trim()) || slug(nombre)) : c.codigo;
    if (!/^[a-z0-9_]{1,30}$/.test(cod)) return formError('cx-err', 'Código no válido.', 'cx-codigo');
    if (nueva && L.some(x => x.codigo === cod)) return formError('cx-err', `Ya existe el código ${cod}.`, 'cx-codigo');
    if (L.some(x => x.codigo !== cod && x.nombre.trim().toLowerCase() === nombre.toLowerCase())) return formError('cx-err', 'Ya existe una con ese nombre.', 'cx-nombre');
    const nv = Object.assign({ nombre, requiere_nota: $('cx-nota').checked, orden: $('cx-orden').value === '' ? null : Math.round(+$('cx-orden').value), updated_at: new Date().toISOString() }, Object.fromEntries(cfg.extras.map(x => [x.k, $('cx-' + x.k).value])));
    try {
      if (nueva) { await DB.insert(t, [Object.assign({ codigo: cod, activa: true }, nv)]); await DB.audit(t, 'alta', `${cod} · ${nombre}`, ACTOR, false); }
      else { const r = await DB.update(t, { codigo: cod }, nv); if (DB.getMode() === 'supabase' && (!r || !r.length)) throw new Error('la base no aceptó el cambio (revisa permisos)'); await DB.audit(t, 'cambio', `${cod} · ${nombre}`, ACTOR, false); }
    } catch (e) { return formError('cx-err', 'No se pudo guardar: ' + (e.message || e)); }
    closeModal(); toast(nueva ? 'Agregada' : 'Actualizada'); await loadAll(); render();
  };
}
function catxExportar(t) { const cfg = CATX[t]; const L = catxFilas(t).length ? catxFilas(t) : cfg.def(); download(`${t}_${hoy()}.csv`, Papa.unparse(L.map(c => Object.assign({ codigo: c.codigo, nombre: c.nombre }, Object.fromEntries(cfg.extras.map(x => [x.k, c[x.k]])), { requiere_nota: !!c.requiere_nota, orden: c.orden ?? '', activa: c.activa !== false })))); }
