/* Catálogo → Rutas: las rutas preestablecidas de DGP (tabla `zonas`), con días de salida, color, tipo y el texto
   exacto del campo «Rutas» de Zoho Books. Se editan aquí; la planificación (regla rutas_por_dia), las tarjetas,
   los paquetes y la sincronización con Zoho leen estos mismos datos. No se borran: se desactivan (los pedidos
   y clientes históricos siguen apuntando a su código). */
const RUTA_COLORES = [['#E53935', 'Rojo'], ['#16A34A', 'Verde'], ['#8B4513', 'Marrón'], ['#A855F7', 'Morado'], ['#F472B6', 'Rosado'], ['#FDE047', 'Amarillo'], ['#2563EB', 'Azul'], ['#6B7280', 'Gris'], ['#111111', 'Negro'], ['#F97316', 'Naranja'], ['#0EA5E9', 'Celeste']];
const rutasOrdenadas = () => S.zonas.slice().sort((a, b) => (b.activa !== false) - (a.activa !== false) || (a.orden ?? 99) - (b.orden ?? 99) || a.codigo.localeCompare(b.codigo));
function renderRutasCat() {
  const puedeEd = puede('catalogo.editar'); const hoyD = ((new Date().getDay() + 6) % 7) + 1;
  const pedidosDe = cod => S.pedidos.filter(p => (p.zona_codigo || (cli(p.cliente_id) || {}).zona_codigo) === cod && !['entregado', 'cancelado'].includes(p.estado)).length;
  $('cat-table').querySelector('thead').innerHTML = '<tr><th>Color</th><th>Código</th><th>Nombre</th><th>Días de salida</th><th>Tipo</th><th>Texto en Zoho («Rutas»)</th><th class="num">Orden</th><th class="num">Pedidos abiertos</th><th>Estado</th><th></th></tr>';
  $('cat-table').querySelector('tbody').innerHTML = rutasOrdenadas().map(z => {
    const sale = !z.dias || !z.dias.length || z.dias.includes(hoyD);
    return `<tr style="${z.activa === false ? 'opacity:.55' : ''}"><td><i style="display:inline-block;width:18px;height:18px;border-radius:5px;border:1px solid #0002;background:${esc(z.color || '#64748B')}"></i></td>
    <td class="code"><b>${esc(z.codigo)}</b></td><td>${esc(z.nombre)}</td>
    <td>${esc(diasTxt(z.dias))}${z.activa !== false && sale ? ' <span class="pill p-ok">sale hoy</span>' : ''}</td>
    <td>${z.tipo === 'retiro' ? '<span class="pill p-mut">Retiro en bodega</span>' : 'Entrega'}</td>
    <td class="mini">${esc(z.zoho_valor || '—')}</td><td class="num">${z.orden ?? ''}</td><td class="num">${pedidosDe(z.codigo)}</td>
    <td>${z.activa === false ? '<span class="pill p-mut">Inactiva</span>' : '<span class="pill p-ok">Activa</span>'}</td>
    <td>${puedeEd ? `<button class="btn sec sm" data-ruta-ed="${esc(z.codigo)}">Editar</button>` : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="10" class="empty">No hay rutas.</td></tr>';
  document.querySelectorAll('[data-ruta-ed]').forEach(b => b.onclick = () => editarRuta(b.dataset.rutaEd));
  const act = S.zonas.filter(z => z.activa !== false).length;
  $('cat-note').innerHTML = `${act} rutas activas de ${S.zonas.length}. Los pedidos de Zoho se asignan a la ruta cuyo «Texto en Zoho» coincide con el campo «Rutas» de la orden (o por número: «Ruta 3…» → R3). Los días de salida mandan en la planificación (regla rutas_por_dia). ${puedeEd ? '<button class="btn sm" id="b-ruta-nueva" style="margin-left:8px">+ Nueva ruta</button>' : ''}`;
  if ($('b-ruta-nueva')) $('b-ruta-nueva').onclick = () => editarRuta(null);
  $('templates').innerHTML = Object.keys(CAT).map(k => `<button class="btn sec sm" data-tpl="${k}">${k}.csv</button>`).join('');
  document.querySelectorAll('[data-tpl]').forEach(b => b.onclick = () => download(`${b.dataset.tpl}.csv`, Papa.unparse({ fields: CAT[b.dataset.tpl], data: [] })));
}
function editarRuta(codigo) {
  if (!exige('catalogo.editar')) return;
  const nueva = !codigo; const z = nueva ? { codigo: '', nombre: '', color: '#2563EB', dias: [], tipo: 'entrega', zoho_valor: '', orden: (Math.max(0, ...S.zonas.map(x => +x.orden || 0)) + 1), activa: true, prioridad: 3 } : S.zonas.find(x => x.codigo === codigo);
  if (!z) return;
  const dias = z.dias || [];
  const colorOpts = RUTA_COLORES.map(([c, n]) => `<button type="button" class="btn sec sm" data-col="${c}" title="${n}" style="padding:4px 8px"><i style="display:inline-block;width:14px;height:14px;border-radius:4px;background:${c};vertical-align:middle"></i> ${n}</button>`).join('');
  modal(`<h2 style="margin-bottom:4px">${nueva ? 'Nueva ruta' : 'Ruta ' + esc(z.codigo)}</h2>
   <p class="mini" style="margin-top:0">Los cambios aplican a la próxima propuesta y a la próxima sincronización con Zoho. Quedan en auditoría.</p>
   <div class="grid g2" style="gap:10px">
    <label class="mini">Código${nueva ? '' : ' (no se cambia: lo usan pedidos y clientes)'}<input id="rz-codigo" value="${esc(z.codigo)}" ${nueva ? '' : 'disabled'} placeholder="R10" style="width:100%;font-family:var(--mono)"></label>
    <label class="mini">Orden en listados<input id="rz-orden" type="number" min="0" step="1" value="${z.orden ?? ''}" style="width:100%"></label>
    <label class="mini" style="grid-column:1/-1">Nombre (sectores que cubre)<input id="rz-nombre" value="${esc(z.nombre)}" placeholder="Ruta 10 · Coclé norte" style="width:100%"></label>
    <label class="mini" style="grid-column:1/-1">Texto exacto del campo «Rutas» en Zoho Books<input id="rz-zoho" value="${esc(z.zoho_valor || '')}" placeholder="Ruta 10 Viernes Coclé" style="width:100%"></label>
   </div>
   <div class="mini" style="margin-top:10px">Días de salida <span class="note">(ninguno marcado = cualquier día)</span></div>
   <div class="row" style="flex-wrap:wrap;gap:10px;margin:4px 0 10px">${[1, 2, 3, 4, 5, 6, 7].map(d => `<label class="mini"><input type="checkbox" data-dia="${d}" ${dias.includes(d) ? 'checked' : ''}> ${DIAS[d]}</label>`).join('')}</div>
   <div class="mini">Color de la etiqueta</div>
   <div class="row" style="flex-wrap:wrap;gap:6px;margin:4px 0">${colorOpts}<input id="rz-color" type="color" value="${esc(/^#[0-9a-f]{6}$/i.test(z.color || '') ? z.color : '#2563EB')}" title="Otro color" style="width:44px;height:30px;padding:0;border:0"></div>
   <div class="grid g2" style="gap:10px;margin-top:10px">
    <label class="mini">Tipo<select id="rz-tipo" style="width:100%"><option value="entrega" ${z.tipo !== 'retiro' ? 'selected' : ''}>Entrega (va en camión)</option><option value="retiro" ${z.tipo === 'retiro' ? 'selected' : ''}>Retiro en bodega (no va en camión)</option></select></label>
    <label class="mini">Estado<select id="rz-activa" style="width:100%"><option value="1" ${z.activa !== false ? 'selected' : ''}>Activa</option><option value="0" ${z.activa === false ? 'selected' : ''}>Inactiva (no se planifica)</option></select></label>
   </div>
   <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn sec" onclick="closeModal()">Cancelar</button><button class="btn" id="rz-ok">Guardar</button></div>`);
  document.querySelectorAll('[data-col]').forEach(b => b.onclick = () => { $('rz-color').value = b.dataset.col; });
  $('rz-ok').onclick = async () => {
    const cod = $('rz-codigo').value.trim().toUpperCase(); const nombre = $('rz-nombre').value.trim();
    if (!cod || !/^[A-Z0-9_-]{1,12}$/.test(cod)) { toast('Código obligatorio: letras, números, guion (máx. 12). Ej.: R10'); return; }
    if (nueva && S.zonas.some(x => x.codigo.toUpperCase() === cod)) { toast(`Ya existe la ruta ${cod}`); return; }
    if (!nombre) { toast('El nombre es obligatorio'); return; }
    const zoho = $('rz-zoho').value.trim() || null;
    const n = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
    const dup = zoho && S.zonas.find(x => x.codigo !== cod && x.zoho_valor && n(x.zoho_valor) === n(zoho)); if (dup) { toast(`Ese texto de Zoho ya es de ${dup.codigo}`); return; }
    const d = [...document.querySelectorAll('[data-dia]')].filter(x => x.checked).map(x => +x.dataset.dia);
    const ord = $('rz-orden').value === '' ? null : Math.round(+$('rz-orden').value);
    const nv = { nombre, color: $('rz-color').value.toUpperCase(), dias: d.length ? d : null, tipo: $('rz-tipo').value, zoho_valor: zoho, orden: ord, activa: $('rz-activa').value === '1' };
    try {
      if (nueva) { await DB.insert('zonas', [Object.assign({ codigo: cod, prioridad: 3 }, nv)]); await DB.audit('zonas', 'alta', `${cod} · ${nombre} · sale ${diasTxt(nv.dias)} · ${nv.tipo} · color ${nv.color}`, ACTOR, false); }
      else {
        const cambios = Object.keys(nv).filter(k => JSON.stringify(z[k] ?? null) !== JSON.stringify(nv[k] ?? null));
        if (!cambios.length) { closeModal(); return; }
        const r = await DB.update('zonas', { codigo: cod }, nv); if (!r || !r.length) throw new Error('la base no aceptó el cambio (revisa permisos del rol)');
        const txt = k => k === 'dias' ? diasTxt : (v => v ?? '—');
        await DB.audit('zonas', 'cambio', `${cod}: ` + cambios.map(k => `${k} ${txt(k)(z[k])} → ${txt(k)(nv[k])}`).join(' · '), ACTOR, false);
      }
    } catch (e) { toast('No se pudo guardar: ' + (e.message || e)); return; }
    closeModal(); toast(nueva ? `Ruta ${cod} creada` : `Ruta ${cod} actualizada. Vuelve a generar la propuesta para aplicarla.`); await loadAll(); render();
  };
}
