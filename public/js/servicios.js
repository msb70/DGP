/* DGP · Paradas de servicio sin factura (20-nov-2026): instalación o mantenimiento de dispensadores, retiro de equipo, visita técnica.
   Se agregan a un viaje con cliente, dirección y tiempo estimado; la app del conductor las muestra como una parada más y
   el conductor (o el técnico que va en el camión) la cierra como realizada o no realizada, con firma y fotos.
   · Viaje que aún no sale: la parada se secuencia con las entregas (recalcula horas y km).
   · Viaje liberado o en ruta: se agrega al final; el conductor la ve al actualizar su app. */
const SV_TIPOS = ['Instalación de dispensadores', 'Mantenimiento de dispensadores', 'Retiro de equipo o dispensador', 'Visita técnica', 'Otro servicio'];
const SV_ABIERTAS = ['simulada', 'aprobada', 'publicada', 'en_cargue', 'liberada', 'en_ruta'];

function agregarServicio(ridPreset) {
  if (!exige('planificar')) return;
  const rutas = S.rutas.filter(r => SV_ABIERTAS.includes(r.estado)).sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || a.codigo.localeCompare(b.codigo));
  if (!rutas.length) return toast('No hay viajes abiertos: genera o publica las rutas primero');
  const cliTxt = k => k ? `${k.codigo} · ${k.nombre}` : '';
  modal(`<h2 style="margin-bottom:4px">Parada de servicio (sin factura)</h2><p class="mini" style="margin-top:0">Para instalar o mantener dispensadores u otros servicios del técnico. El conductor la ve en su app y la cierra con firma y fotos.</p>
    <div class="grid g2" style="gap:10px">
      <label class="mini" style="grid-column:1/-1">Viaje *<select id="sv-r" style="width:100%">${rutas.map(r => `<option value="${r.id}">${esc(r.codigo)} · ${esc(r.fecha || '')} · ${esc((veh(r.vehiculo_id) || {}).placa || '')} · ${esc(r.conductor || 'sin conductor')} · ${esc(r.estado)}</option>`).join('')}</select></label>
      <div id="sv-aviso" class="mini" style="grid-column:1/-1"></div>
      <label class="mini" style="grid-column:1/-1">Cliente * <span id="sv-cn"></span><input id="sv-cli" list="sv-cli-l" placeholder="Código o nombre" autocomplete="off" style="width:100%"><datalist id="sv-cli-l">${S.clientes.slice(0, 4000).map(k => `<option value="${esc(cliTxt(k))}">`).join('')}</datalist></label>
      <label class="mini" style="grid-column:1/-1">Dirección del servicio *<input id="sv-dir" maxlength="250" style="width:100%"></label>
      <label class="mini">Servicio *<select id="sv-tipo" style="width:100%">${SV_TIPOS.map(t => `<option>${t}</option>`).join('')}</select></label>
      <label class="mini">Tiempo estimado (min) *<input id="sv-min" type="number" min="5" max="480" step="5" value="30" style="width:100%"></label>
      <label class="mini">Técnico (si va en el camión)<input id="sv-tec" maxlength="60" style="width:100%" placeholder="Opcional"></label>
      <label class="mini"><input type="checkbox" id="sv-urg"> Urgente (va primero que lo no urgente)</label>
      <label class="mini" style="grid-column:1/-1">Detalle para el conductor / técnico<input id="sv-det" maxlength="250" style="width:100%" placeholder="Ej.: 2 dispensadores de papel toalla en baños del 2.º piso; llevar taladro"></label>
    </div><div class="form-err" id="sv-err" hidden></div>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn sec" onclick="closeModal()">Cancelar</button><button class="btn" id="sv-ok">Agregar al viaje</button></div>`);
  if (ridPreset && rutas.some(r => r.id === ridPreset)) $('sv-r').value = ridPreset;
  const aviso = () => { const r = rutas.find(x => x.id === $('sv-r').value); $('sv-aviso').innerHTML = ['liberada', 'en_ruta'].includes(r.estado) ? '<span class="pill p-warn">El viaje ya fue liberado</span> La parada se agrega al final; el conductor la verá al actualizar su app.' : r.estado === 'simulada' ? '<span class="pill p-warn">Propuesta sin aprobar</span> Si vuelves a generar la propuesta, esta parada se pierde: agrégala después de aprobar.' : 'La parada se ordena con las entregas y se recalculan horas y kilómetros.'; };
  $('sv-r').onchange = aviso; aviso();
  const cliSel = () => { const v = $('sv-cli').value.trim(); return S.clientes.find(k => cliTxt(k) === v) || S.clientes.find(k => k.codigo === v) || null; };
  $('sv-cli').oninput = () => { const k = cliSel(); $('sv-cn').innerHTML = k ? `<span class="pill p-ok nodot">${esc(k.nombre)}</span>${k.lat == null ? ' <span class="pill p-warn nodot">sin coordenadas</span>' : ''}` : ''; if (k && !$('sv-dir').value.trim()) $('sv-dir').value = k.direccion || ''; };
  $('sv-ok').onclick = async () => {
    document.querySelectorAll('.campo-error').forEach(x => x.classList.remove('campo-error'));
    const r = rutas.find(x => x.id === $('sv-r').value); const k = cliSel(); if (!k) return formError('sv-err', 'Elige el cliente de la lista.', 'sv-cli');
    const dir = $('sv-dir').value.trim(); if (dir.length < 5) return formError('sv-err', 'Escribe la dirección del servicio.', 'sv-dir');
    const min = Math.round(+$('sv-min').value); if (!(min >= 5 && min <= 480)) return formError('sv-err', 'El tiempo estimado va de 5 a 480 minutos.', 'sv-min');
    $('sv-ok').disabled = true;
    let lat = k.lat, lng = k.lng;
    if (dir !== (k.direccion || '') || lat == null) { try { const g = await GEO.geocode(dir + ', Panamá'); if (g) { lat = g.lat; lng = g.lng; } } catch (e) { } }
    if (lat == null) { $('sv-ok').disabled = false; return formError('sv-err', 'No hay coordenadas para esa dirección. Calcula las del cliente en Catálogo o escribe una dirección más precisa.', 'sv-dir'); }
    const tipo = $('sv-tipo').value, tec = $('sv-tec').value.trim(), det = $('sv-det').value.trim(), urg = $('sv-urg').checked;
    const notas = `🔧 ${tipo}${urg ? ' · URGENTE' : ''}${tec ? ' · técnico: ' + tec : ''}${det ? ' · ' + det : ''} · Dirección: ${dir}`;
    const nueva = { id: DB.uuid(), ruta_id: r.id, tipo: 'servicio', cliente_id: k.id, pedido_id: null, lat: +lat, lng: +lng, duracion_min: min, estado: 'pendiente', notas, prioridad: urg ? 1 : 0 };
    try {
      if (editable(r)) {   // se ordena con las entregas
        r._serv = S.paradas.filter(x => x.ruta_id === r.id && x.tipo === 'servicio').concat([nueva]);
        r._ped = S.pedidos.filter(p => p.ruta_id === r.id);
        await secuenciar(r);
        await DB.remove('paradas', { ruta_id: r.id }); await DB.insert('paradas', r._stops.map(s => Object.assign({ ruta_id: r.id }, s)));
        const pub = r.estado !== 'simulada'; const { _ped, _stops, _serv, ...row } = r; if (pub) { row.version = (+r.version || 1) + 1; row.cambios = (+r.cambios || 0) + 1; }
        await DB.update('rutas', { id: r.id }, row);
      } else {             // viaje ya liberado o en ruta: al final
        const ps = S.paradas.filter(x => x.ruta_id === r.id); const { prioridad, ...fila } = nueva;
        await DB.insert('paradas', [Object.assign(fila, { secuencia: Math.max(0, ...ps.map(x => +x.secuencia || 0)) + 1, eta: null, km_tramo: null })]);
      }
      await DB.audit('paradas', 'servicio_agregado', `${r.codigo}: ${tipo} en ${k.nombre} (${min} min)${tec ? ' · técnico ' + tec : ''}${editable(r) ? '' : ' · agregado al final (viaje ya liberado)'}`, ACTOR, false, r.id);
      if (r.conductor && !editable(r)) await DB.notificar('telegram', r.conductor, 'conductor', `Nueva parada de servicio · ${r.codigo}`, `${tipo} en ${k.nombre}: ${dir}. Actualiza la app.`, 'parada de servicio', r.id);
    } catch (e) { $('sv-ok').disabled = false; return formError('sv-err', 'No se pudo agregar: ' + (e.message || e)); }
    closeModal(); toast(`Parada de servicio agregada a ${r.codigo}`); await loadAll(); render();
  };
}
if ($('b-servicio')) $('b-servicio').onclick = () => agregarServicio();
