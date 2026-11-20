/* DGP · Resolver excepción (20-nov-2026). Sustituye al «Triage de excepciones con IA».
   Un pedido en excepción se resuelve con una CAUSA obligatoria (auditada) y una ACCIÓN:
   - agregarlo a una ruta ya planificada (camión de esa ruta), o
   - crear un viaje nuevo eligiendo la ruta de Zoho y el camión, o
   - diferirlo a mañana.
   Si la dirección no tiene coordenadas, pide la ubicación (la del cliente o una pegada de WhatsApp / Google Maps)
   y la guarda en la dirección de entrega para los próximos pedidos (geo_estado «aproximada»: el GPS de la primera entrega la valida). */
const EXC_CAUSAS = [
  ['gerencia', 'Autorizado por gerencia de operaciones'],
  ['credito', 'Crédito autorizado por CxC / ejecutivo'],
  ['minimo', 'Monto bajo el mínimo aceptado (cliente estratégico o urgencia)'],
  ['direccion', 'Dirección confirmada con el cliente o el ejecutivo'],
  ['ruta_zoho', 'Ruta de Zoho asignada a mano'],
  ['otra', 'Otra (explicar en la nota)']
];
/* Causas activas del catálogo (tabla causas_resolucion); si la base no las tiene (modo demo), las de arriba. */
function excCausas() {
  const db = (S.causas || []).filter(c => c.activa !== false).sort((a, b) => (a.orden ?? 99) - (b.orden ?? 99) || a.nombre.localeCompare(b.nombre));
  return (S.causas || []).length ? db : EXC_CAUSAS.map((x, i) => ({ codigo: x[0], nombre: x[1], requiere_nota: x[0] === 'otra', orden: i }));
}
/* Error visible dentro del formulario: recuadro rojo junto a los botones + el campo en rojo (y foco). Se limpia al corregir. */
function formError(boxId, msg, campoId) {
  document.querySelectorAll('.campo-error').forEach(x => x.classList.remove('campo-error'));
  const box = $(boxId); if (box) { box.innerHTML = `<span><b>No se puede aplicar.</b> ${esc(msg)}</span>`; box.hidden = false; box.classList.remove('sacude'); void box.offsetWidth; box.classList.add('sacude'); }
  const c = campoId && $(campoId);
  if (c) { c.classList.add('campo-error'); c.scrollIntoView({ block: 'center', behavior: 'smooth' }); const f = c.matches('input,select,textarea') ? c : c.querySelector('input:not([disabled]),select:not([disabled])'); if (f) setTimeout(() => f.focus({ preventScroll: true }), 250);
    const limpiar = () => { c.classList.remove('campo-error'); if (box) box.hidden = true; }; c.addEventListener('input', limpiar, { once: true }); c.addEventListener('change', limpiar, { once: true }); }
  return false;
}
const EXC_PANAMA = { lat: [7, 10], lng: [-83.1, -77.1] };
/* Acepta «8.98, -79.52», «8.98 -79.52» o enlaces de Google Maps (…@8.98,-79.52…, …q=8.98,-79.52…, …ll=…, !3d8.98!4d-79.52). */
function excParseUbic(txt) {
  const s = String(txt || '').trim(); if (!s) return null;
  const pats = [/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/, /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/, /[?&](?:q|ll|query|destination)=(-?\d+(?:\.\d+)?)(?:,|%2C)\s*(-?\d+(?:\.\d+)?)/i, /^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/];
  for (const re of pats) { const m = s.match(re); if (m) { const lat = +m[1], lng = +m[2]; if (lat >= EXC_PANAMA.lat[0] && lat <= EXC_PANAMA.lat[1] && lng >= EXC_PANAMA.lng[0] && lng <= EXC_PANAMA.lng[1]) return { lat, lng }; return { fuera: true, lat, lng }; } }
  return null;
}
const excRetiro = p => zona(zonaPed(p)).tipo === 'retiro';
const excSinCoord = p => !excRetiro(p) && dst(p).lat == null;
const excLibre = v => !S.rutas.some(r => r.vehiculo_id === v.id && r.fecha === hoy());
const excN = x => Math.round(+x || 0).toLocaleString('es-PA');
const excCap = (r, v) => `${excN(r.cajas)}/${excN(v.cap_cajas)} cajas · ${excN(r.peso_kg)}/${excN(v.cap_peso_kg)} kg`;

function resolverExcepcion(pedId) {
  if (!exige('planificar')) return;
  const p = S.pedidos.find(x => x.id === pedId); if (!p) return; const c = cli(p.cliente_id) || {}; const zp = zonaPed(p);
  const rutas = S.rutas.filter(editable).sort((a, b) => (b.zona_codigo === zp) - (a.zona_codigo === zp) || a.codigo.localeCompare(b.codigo));
  const zonas = S.zonas.filter(z => z.activa !== false).sort((a, b) => (+a.orden || 99) - (+b.orden || 99) || a.codigo.localeCompare(b.codigo));
  const vehs = S.vehiculos.filter(v => v.activo !== false && +v.cap_cajas > 0).sort((a, b) => excLibre(b) - excLibre(a) || (a.placa || '').localeCompare(b.placa || ''));
  const sinCoord = excSinCoord(p); const d = dst(p); const cliCoord = p.direccion_id && c.lat != null ? { lat: +c.lat, lng: +c.lng } : null; // la dirección del pedido no tiene coordenada pero el cliente sí
  modal(`<div class="hd"><div><h2>Resolver excepción · ${esc(p.numero_so)}</h2><div class="mini">${esc(c.nombre || '')} · ${esc(p.numero_factura || 'sin factura')} · B/. ${fmt(p.valor)} · ${p.cajas} cajas · ${f1(p.peso_kg)} kg</div></div></div>
  <div class="alert warn" style="margin-bottom:10px"><span class="dot"></span><div><b>Motivo de la excepción</b><div class="mini">${esc(p.causa || '—')}</div></div></div>
  <label class="f">Causa de la resolución *<select id="ex-causa"><option value="">Elige la causa…</option>${excCausas().map(x => `<option value="${esc(x.codigo)}">${esc(x.nombre)}${x.requiere_nota ? ' · requiere nota' : ''}</option>`).join('')}</select></label>
  <label class="f" style="margin-top:8px">Nota <span class="mini">(obligatoria en las causas marcadas «requiere nota»; queda en la auditoría)</span><input id="ex-nota" maxlength="200" placeholder="Ej.: lo aprobó Juan Pérez por teléfono"></label>
  ${sinCoord ? `<div class="card flat" id="ex-ubic-box" style="margin-top:10px;padding:10px"><b>Ubicación de la entrega</b><div class="mini" style="margin:2px 0 6px">La dirección «${esc(String(d.direccion || '').slice(0, 90))}» no tiene coordenadas y sin ellas no se puede secuenciar la ruta. Se guarda en la dirección para los próximos pedidos; el GPS de la primera entrega la confirma.</div>
    ${cliCoord ? `<label class="mini" style="display:block;margin-bottom:6px"><input type="radio" name="ex-ub" value="cliente" checked> Usar la ubicación del cliente en el catálogo (${cliCoord.lat.toFixed(5)}, ${cliCoord.lng.toFixed(5)})</label>` : ''}
    <label class="mini" style="display:block"><input type="radio" name="ex-ub" value="pegar" ${cliCoord ? '' : 'checked'}> Pegar ubicación (latitud, longitud o enlace de Google Maps / WhatsApp)</label>
    <input id="ex-ubic" placeholder="8.9824, -79.5199  ó  https://maps.google.com/…" style="margin-top:6px;width:100%"><div class="mini" id="ex-ubic-ok" style="margin-top:4px"></div></div>` : ''}
  <div id="ex-acc-box" style="margin-top:12px;padding:6px 8px;border-radius:10px"><b>Acción</b>
  <label class="mini" style="display:block;margin-top:6px"><input type="radio" name="ex-acc" value="ruta" ${rutas.length ? 'checked' : 'disabled'}> Agregar a una ruta ya planificada${rutas.length ? '' : ' <span class="pill p-mut nodot">no hay rutas abiertas hoy</span>'}</label>
  <select id="ex-ruta" style="width:100%;margin-top:4px" ${rutas.length ? '' : 'disabled'}>${rutas.map(r => { const v = veh(r.vehiculo_id) || {}; return `<option value="${r.id}">${r.zona_codigo === zp ? '★ ' : ''}${esc(r.codigo)} · ${esc(r.color_nombre || zona(r.zona_codigo).nombre || '')} · ${esc(v.placa || '')} ${esc(v.nombre || tipoVeh(v.tipo))} · ${excCap(r, v)} · ${esc(r.estado)}</option>`; }).join('')}</select>
  <label class="mini" style="display:block;margin-top:10px"><input type="radio" name="ex-acc" value="nueva" ${rutas.length ? '' : 'checked'}> Crear un viaje nuevo con un camión</label>
  <div class="row" style="margin-top:4px;gap:8px"><select id="ex-zona" style="flex:1;min-width:0">${zonas.map(z => `<option value="${z.codigo}" ${z.codigo === zp ? 'selected' : ''}>${esc(z.codigo)} · ${esc(z.nombre)}</option>`).join('')}</select>
    <select id="ex-veh" style="flex:1;min-width:0">${vehs.map(v => `<option value="${v.id}">${esc(v.placa)} ${esc(v.nombre || '')} · ${esc(tipoVeh(v.tipo))} · ${excN(v.cap_cajas)} cajas · ${excN(v.cap_peso_kg)} kg${excLibre(v) ? ' · libre' : ' · ya sale hoy (otro viaje)'}</option>`).join('')}</select></div>
  <label class="mini" style="display:block;margin-top:10px"><input type="radio" name="ex-acc" value="diferir"> Diferir a mañana</label></div>
  <label class="mini" id="ex-forzar-box" style="display:block;margin-top:10px;padding:4px 6px;border-radius:8px"><input type="checkbox" id="ex-forzar"> Agregar aunque supere la capacidad del camión (queda marcado y auditado)</label>
  <div class="mini" style="margin-top:8px">★ = misma ruta de Zoho del pedido${zp ? ` (${esc(zp)})` : ''}. ${p.zoho_salesorder_id ? 'La ruta de la orden en Zoho no cambia.' : ''}</div>
  <div class="form-err" id="ex-err" hidden></div>
  <div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn sec" id="ex-cancel">Cancelar</button><button class="btn" id="ex-ok">Aplicar</button></div>`);
  const ub = $('ex-ubic'); if (ub) ub.oninput = () => { const g = excParseUbic(ub.value); $('ex-ubic-ok').innerHTML = !ub.value.trim() ? '' : !g ? '<span class="ind-no">No reconozco la ubicación</span>' : g.fuera ? '<span class="ind-no">Queda fuera de Panamá</span>' : `<span class="ind-ok">✓ ${g.lat.toFixed(5)}, ${g.lng.toFixed(5)}</span>`; const r = document.querySelector('input[name="ex-ub"][value="pegar"]'); if (r) r.checked = true; };
  $('ex-ruta').onfocus = () => { const r = document.querySelector('input[name="ex-acc"][value="ruta"]'); if (r && !r.disabled) r.checked = true; };
  $('ex-zona').onfocus = $('ex-veh').onfocus = () => { document.querySelector('input[name="ex-acc"][value="nueva"]').checked = true; };
  $('ex-cancel').onclick = closeModal;
  $('ex-ok').onclick = () => aplicarResolucion(p.id, cliCoord);
}

async function aplicarResolucion(pedId, cliCoord) {
  const p = S.pedidos.find(x => x.id === pedId); const c = cli(p.cliente_id) || {};
  const causa = $('ex-causa').value, nota = $('ex-nota').value.trim(); const acc = (document.querySelector('input[name="ex-acc"]:checked') || {}).value; const forzar = $('ex-forzar').checked;
  if (!causa) return formError('ex-err', 'Elige la causa de la resolución.', 'ex-causa');
  const cdef = excCausas().find(x => x.codigo === causa) || {};
  if (cdef.requiere_nota && !nota) return formError('ex-err', 'La causa elegida requiere una nota: explica el motivo.', 'ex-nota');
  if (!acc) return formError('ex-err', 'Elige la acción: agregar a una ruta, crear un viaje o diferir.', 'ex-acc-box');
  const txtCausa = (cdef.nombre || causa) + (nota ? ` · ${nota}` : '');
  const motivo = `excepción resuelta por ${ACTOR}: ${txtCausa}`;
  if (acc === 'diferir') {
    if (!exige('pedidos.validar')) return;
    await DB.update('pedidos', { id: p.id }, { estado: 'diferido', ruta_id: null, causa: `Diferido a mañana (${motivo})` });
    await DB.audit('pedidos', 'excepcion_resuelta', `${p.numero_so}: diferido · causa: ${txtCausa} · motivo original: ${p.causa || '—'}`, ACTOR, false, p.id);
    closeModal(); toast(`${p.numero_so} diferido`); await loadAll(); render(); return;
  }
  // ubicación (solo si falta)
  let ubic = null;
  if (excSinCoord(p)) {
    const modo = (document.querySelector('input[name="ex-ub"]:checked') || {}).value;
    if (modo === 'cliente' && cliCoord) ubic = Object.assign({ fuente: 'cliente' }, cliCoord);
    else { const g = excParseUbic($('ex-ubic').value); if (!g) return formError('ex-err', 'Falta la ubicación de la entrega: pega latitud, longitud o un enlace de Google Maps / WhatsApp.', 'ex-ubic'); if (g.fuera) return formError('ex-err', 'La ubicación pegada queda fuera de Panamá. Revísala.', 'ex-ubic'); ubic = Object.assign({ fuente: 'manual' }, g); }
  }
  // destino
  let dest = null, nueva = null;
  if (acc === 'ruta') { dest = S.rutas.find(r => r.id === $('ex-ruta').value); if (!dest || !editable(dest)) return formError('ex-err', 'Esa ruta ya salió o ya no existe. Elige otra.', 'ex-ruta'); }
  else {
    const v = veh($('ex-veh').value), z = $('ex-zona').value; if (!v || !z) return formError('ex-err', 'Elige la ruta de Zoho y el camión del viaje nuevo.', $('ex-veh').value ? 'ex-zona' : 'ex-veh');
    const ok = cabe({ volumen_m3: 0, peso_kg: 0, cajas: 0 }, v, p); const f = Object.keys(ok).find(k => !ok[k]);
    if (f && !forzar) return formError('ex-err', `No cabe en ${v.placa}: supera ${QN[f]}. Elige otro camión o marca «Agregar aunque supere la capacidad».`, 'ex-forzar-box');
    nueva = { v, z };
  }
  if (dest && !forzar) { const w = veh(dest.vehiculo_id); const ok = cabe({ volumen_m3: dest.volumen_m3, peso_kg: dest.peso_kg, cajas: dest.cajas }, w, p); const f = Object.keys(ok).find(k => !ok[k]); if (f) return formError('ex-err', `No cabe en ${dest.codigo} (${w.placa}): supera ${QN[f]}. Elige otra ruta o marca «Agregar aunque supere la capacidad».`, 'ex-forzar-box'); }
  // 1. guardar la ubicación en la dirección (el trigger de la base la copia a los pedidos de esa dirección)
  if (ubic) {
    const e = { entrega_lat: ubic.lat, entrega_lng: ubic.lng, entrega_geo_estado: 'aproximada' };
    await DB.update('pedidos', { id: p.id }, e); Object.assign(p, e);                       // el pedido siempre (permiso de planificar)
    if (puede('catalogo.editar')) {                                                          // y la dirección, para los próximos pedidos
      const geo = { lat: ubic.lat, lng: ubic.lng, geo_estado: 'aproximada', geo_fuente: ubic.fuente === 'cliente' ? 'catalogo_cliente' : 'manual', geo_detalle: `Confirmada por ${ACTOR} al resolver la excepción de ${p.numero_so}`, geo_at: new Date().toISOString() };
      try {
        if (p.direccion_id) await DB.update('cliente_direcciones', { id: p.direccion_id }, geo);
        else if (c.id && c.lat == null) await DB.update('clientes', { id: c.id }, { lat: ubic.lat, lng: ubic.lng, geo_estado: 'aproximada' });
      } catch (e) { toast('La ubicación quedó en el pedido, pero no se pudo guardar en la dirección del cliente: ' + (e.message || e)); }
    }
  }
  // 2. agregar a la ruta o crear el viaje
  if (dest) { await moverPedido(p.id, dest.id, motivo, forzar); }
  else await crearViajeManual(p, nueva.v, nueva.z, motivo);
  const pf = S.pedidos.find(x => x.id === p.id) || {};
  if (pf.estado !== 'planificado') return; // moverPedido ya avisó por qué no se pudo
  if (/crédito/i.test(p.causa || '')) await DB.alerta('credito', 'media', `Despachado con crédito bloqueado · ${c.nombre}`, `${p.numero_so} B/. ${fmt(p.valor)} agregado a ruta por ${ACTOR}: ${txtCausa}`, 'pedido', 'Cuentas por cobrar');
  await DB.audit('pedidos', 'excepcion_resuelta', `${p.numero_so}: ${dest ? 'agregado a ' + dest.codigo : 'viaje nuevo ' + (S.rutas.find(r => r.id === pf.ruta_id) || {}).codigo + ' con ' + nueva.v.placa}${forzar ? ' (capacidad forzada)' : ''}${ubic ? ` · ubicación ${ubic.fuente === 'cliente' ? 'del catálogo del cliente' : 'pegada a mano'} ${ubic.lat.toFixed(5)}, ${ubic.lng.toFixed(5)}` : ''} · causa: ${txtCausa} · motivo original: ${p.causa || '—'}`, ACTOR, false, p.id);
  closeModal(); render();
}

/* Viaje nuevo de un solo pedido: misma forma que las rutas del motor. Si ya hay rutas publicadas hoy, nace publicado (con manifiesto y paquete). */
async function crearViajeManual(p, v, z, motivo) {
  const hoyR = S.rutas.filter(r => r.fecha === hoy()); const n = hoyR.reduce((m, r) => Math.max(m, +(String(r.codigo).match(/(\d+)$/) || [0, 0])[1]), 0) + 1;
  const publicar = hoyR.some(r => r.estado !== 'simulada'); const zz = zona(z); const preest = /^R\d+$/.test(z);
  const r = { id: DB.uuid(), codigo: `R-${String(n).padStart(2, '0')}`, fecha: hoy(), vehiculo_id: v.id, conductor: v.conductor, ayudante: v.ayudante, zona_codigo: z, bodega_codigo: (S.bodega || {}).codigo || 'VA', estado: publicar ? 'publicada' : 'simulada', version: 1, cambios: 0, valor: 0, peso_kg: 0, volumen_m3: 0, cajas: 0, posiciones: 0, limite: null, hora_salida: R('hora_salida').valor || '07:00', color: preest && zz.color ? zz.color : v.color, color_nombre: preest ? (zz.nombre || '').split(' ·')[0] + ' · viaje adicional' : (v.color_nombre || ''), minimo: minimoDe(v) };
  Object.assign(r, totalesDe([p])); r._ped = [p]; r.bajo_minimo = r.valor < r.minimo;
  const ok = cabe({ volumen_m3: 0, peso_kg: 0, cajas: 0 }, v, p); const f = Object.keys(ok).filter(k => !ok[k]).map(k => QN[k]); if (f.length) r.limite = `excede ${f.join(', ')}`;
  await secuenciar(r); const paradas = r._stops; const { _ped, _stops, ...row } = r;
  await DB.insert('rutas', [row]); await DB.insert('paradas', paradas.map(s => Object.assign({ ruta_id: r.id }, s)));
  await DB.update('pedidos', { id: p.id }, { ruta_id: r.id, estado: 'planificado', causa: `Viaje nuevo ${r.codigo} con ${v.placa} (${motivo})` });
  await loadAll(); const rr = S.rutas.find(x => x.id === r.id);
  if (publicar && rr) { await generarDocsRuta(rr); if (rr.conductor) await DB.notificar('telegram', rr.conductor, 'conductor', `Nuevo viaje ${rr.codigo}`, `${rr.codigo} con ${v.placa}: ${p.numero_factura || p.numero_so} (${(cli(p.cliente_id) || {}).nombre || ''}). Imprimir su paquete con color ${rr.color_nombre || ''}.`, 'viaje adicional', rr.id); }
  await DB.audit('rutas', 'viaje_manual', `${r.codigo} creado a mano con ${v.placa} (${z}) para ${p.numero_so} · ${r.estado}${r.limite ? ' · ' + r.limite : ''}`, ACTOR, false, r.id);
  toast(`${p.numero_so} → viaje nuevo ${r.codigo} (${v.placa})`); await loadAll();
}

// ===================== CATÁLOGO → CAUSAS DE RESOLUCIÓN =====================
const causasOrdenadas = () => (S.causas || []).slice().sort((a, b) => (b.activa !== false) - (a.activa !== false) || (a.orden ?? 99) - (b.orden ?? 99) || a.nombre.localeCompare(b.nombre));
function renderCausasCat() {
  const ed = puede('catalogo.editar'); const usos = c => S.auditoria.filter(a => a.accion === 'excepcion_resuelta' && (a.detalle || '').includes('causa: ' + c.nombre)).length;
  $('cat-table').querySelector('thead').innerHTML = '<tr><th>Código</th><th>Causa</th><th>Requiere nota</th><th class="num">Orden</th><th class="num">Usos recientes</th><th>Estado</th><th></th></tr>';
  $('cat-table').querySelector('tbody').innerHTML = causasOrdenadas().map(c => `<tr style="${c.activa === false ? 'opacity:.55' : ''}"><td class="code"><b>${esc(c.codigo)}</b></td><td>${esc(c.nombre)}</td><td>${c.requiere_nota ? '<span class="pill p-warn">Sí</span>' : 'No'}</td><td class="num">${c.orden ?? ''}</td><td class="num">${usos(c)}</td><td>${c.activa === false ? '<span class="pill p-mut">Inactiva</span>' : '<span class="pill p-ok">Activa</span>'}</td><td>${ed ? `<button class="btn sec sm" data-causa-ed="${esc(c.codigo)}">Editar</button>` : ''}</td></tr>`).join('')
    || `<tr><td colspan="7" class="empty">No hay causas en el catálogo: el formulario usa las causas por defecto. Crea la primera con «+ Nueva causa».</td></tr>`;
  $('cat-note').innerHTML = `Causas que se eligen en Pedidos → «Resolver excepción» al agregar un pedido a una ruta o camión, crear un viaje o diferirlo. Quedan en la auditoría. No se borran: se desactivan. ${ed ? '<button class="btn sm" id="b-causa-nueva">+ Nueva causa</button>' : ''}`;
  if ($('b-causa-nueva')) $('b-causa-nueva').onclick = () => editarCausa(null);
  document.querySelectorAll('[data-causa-ed]').forEach(b => b.onclick = () => editarCausa(b.dataset.causaEd));
  $('templates').innerHTML = '';
}
function editarCausa(codigo) {
  if (!exige('catalogo.editar')) return;
  const nueva = !codigo; const c = nueva ? { codigo: '', nombre: '', requiere_nota: false, orden: Math.max(0, ...(S.causas || []).filter(x => (x.orden ?? 0) < 90).map(x => +x.orden || 0)) + 1, activa: true } : (S.causas || []).find(x => x.codigo === codigo);
  if (!c) return;
  modal(`<h2 style="margin-bottom:4px">${nueva ? 'Nueva causa de resolución' : 'Causa ' + esc(c.codigo)}</h2>
   <p class="mini" style="margin-top:0">Aparece en Pedidos → «Resolver excepción». Los cambios quedan en auditoría.</p>
   <div class="grid g2" style="gap:10px">
    <label class="mini" style="grid-column:1/-1">Causa (texto que ve el usuario)<input id="cr-nombre" value="${esc(c.nombre)}" maxlength="120" placeholder="Ej.: Cliente VIP autorizado por gerencia comercial" style="width:100%"></label>
    <label class="mini">Código${nueva ? ' (se genera del texto si lo dejas vacío)' : ' (no se cambia)'}<input id="cr-codigo" value="${esc(c.codigo)}" ${nueva ? '' : 'disabled'} placeholder="cliente_vip" style="width:100%;font-family:var(--mono)"></label>
    <label class="mini">Orden en la lista<input id="cr-orden" type="number" min="0" step="1" value="${c.orden ?? ''}" style="width:100%"></label>
    <label class="mini"><input type="checkbox" id="cr-nota" ${c.requiere_nota ? 'checked' : ''}> Requiere nota (el usuario debe explicar)</label>
    <label class="mini">Estado<select id="cr-activa" style="width:100%"><option value="1" ${c.activa !== false ? 'selected' : ''}>Activa</option><option value="0" ${c.activa === false ? 'selected' : ''}>Inactiva (no aparece)</option></select></label>
   </div>
   <div class="form-err" id="cr-err" hidden></div>
   <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn sec" onclick="closeModal()">Cancelar</button><button class="btn" id="cr-ok">Guardar</button></div>`);
  $('cr-ok').onclick = async () => {
    const nombre = $('cr-nombre').value.trim(); if (nombre.length < 3) return formError('cr-err', 'Escribe la causa (mínimo 3 caracteres).', 'cr-nombre');
    const slug = t => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
    const cod = nueva ? (slug($('cr-codigo').value.trim()) || slug(nombre)) : c.codigo;
    if (!/^[a-z0-9_]{1,30}$/.test(cod)) return formError('cr-err', 'Código no válido: solo letras, números y guion bajo.', 'cr-codigo');
    if (nueva && (S.causas || []).some(x => x.codigo === cod)) return formError('cr-err', `Ya existe la causa con código ${cod}.`, 'cr-codigo');
    if ((S.causas || []).some(x => x.codigo !== cod && x.nombre.trim().toLowerCase() === nombre.toLowerCase())) return formError('cr-err', 'Ya existe una causa con ese texto.', 'cr-nombre');
    const nv = { nombre, requiere_nota: $('cr-nota').checked, orden: $('cr-orden').value === '' ? null : Math.round(+$('cr-orden').value), activa: $('cr-activa').value === '1', updated_at: new Date().toISOString() };
    try {
      if (nueva) { await DB.insert('causas_resolucion', [Object.assign({ codigo: cod }, nv)]); await DB.audit('causas_resolucion', 'alta', `${cod} · ${nombre}${nv.requiere_nota ? ' · requiere nota' : ''}`, ACTOR, false); }
      else {
        const cambios = ['nombre', 'requiere_nota', 'orden', 'activa'].filter(k => (c[k] ?? null) !== (nv[k] ?? null)); if (!cambios.length) { closeModal(); return; }
        const r = await DB.update('causas_resolucion', { codigo: cod }, nv); if (!r || !r.length) throw new Error('la base no aceptó el cambio (revisa permisos del rol)');
        await DB.audit('causas_resolucion', 'cambio', `${cod}: ` + cambios.map(k => `${k} ${c[k] ?? '—'} → ${nv[k] ?? '—'}`).join(' · '), ACTOR, false);
      }
    } catch (e) { return formError('cr-err', 'No se pudo guardar: ' + (e.message || e)); }
    closeModal(); toast(nueva ? 'Causa creada' : 'Causa actualizada'); await loadAll(); render();
  };
}

// ===================== PEDIDOS → FILTRO POR RUTA (todas, varias o una) =====================
/* Ruta = la ruta de Zoho del pedido (zona_codigo). null = todas. Se recuerda en este navegador. */
const PEDF = { sel: (() => { try { const v = JSON.parse(localStorage.getItem('dgp_ped_rutas') || 'null'); return Array.isArray(v) ? new Set(v) : null; } catch (e) { return null; } })() };
const pedFGuardar = () => { try { localStorage.setItem('dgp_ped_rutas', JSON.stringify(PEDF.sel ? [...PEDF.sel] : null)); } catch (e) { } };
const pedRutaDe = p => zonaPed(p) || '__sin';
function pedFiltrar(rows) {
  const total = rows.length; const out = PEDF.sel ? rows.filter(p => PEDF.sel.has(pedRutaDe(p))) : rows;
  renderPedFiltro(total, out.length); return out;
}
function renderPedFiltro(total, vis) {
  const el = $('ped-filtro'); if (!el) return; const abierto = !!(el.querySelector('details') || {}).open;
  const usadas = new Set(S.pedidos.map(pedRutaDe));
  const ops = S.zonas.filter(z => z.activa !== false || usadas.has(z.codigo)).sort((a, b) => (a.orden ?? 99) - (b.orden ?? 99) || a.codigo.localeCompare(b.codigo)).map(z => ({ k: z.codigo, n: `${z.codigo} · ${(z.nombre || '').split(' ·')[0]}`, c: z.color }));
  if (usadas.has('__sin')) ops.push({ k: '__sin', n: 'Sin ruta', c: '#94A3B8' });
  const cuenta = k => S.pedidos.filter(p => pedRutaDe(p) === k).length; const sel = PEDF.sel;
  const resumen = !sel ? 'Todas' : !sel.size ? 'Ninguna' : sel.size === 1 ? ops.filter(o => sel.has(o.k)).map(o => o.n)[0] || [...sel][0] : `${sel.size} rutas`;
  el.innerHTML = `<b class="mini">Rutas</b><details class="dd" style="position:relative"><summary class="btn sec sm" style="list-style:none;cursor:pointer">${esc(resumen)} ▾</summary>
    <div class="card" style="position:absolute;z-index:30;top:36px;left:0;min-width:280px;max-height:380px;overflow:auto;padding:10px;box-shadow:0 8px 24px #0002">
     <div class="row" style="gap:6px;margin-bottom:8px"><button class="btn sec xs" data-pf="todas">Todas</button><button class="btn sec xs" data-pf="ninguna">Ninguna</button></div>
     ${ops.map(o => `<label class="mini" style="display:flex;align-items:center;gap:6px;padding:3px 0"><input type="checkbox" data-pfr="${esc(o.k)}" ${!sel || sel.has(o.k) ? 'checked' : ''}><span class="swatch" style="background:${esc(o.c || '#64748B')}"></span>${esc(o.n)} <span class="note" style="margin-left:auto">${cuenta(o.k)}</span></label>`).join('')}
    </div></details>
    ${ops.filter(o => !sel || sel.has(o.k)).length && sel ? ops.filter(o => sel.has(o.k)).map(o => `<span class="pill nodot" style="background:${esc(o.c || '#64748B')};color:${claroHex(o.c || '#64748B') ? '#0F172A' : '#fff'}">${esc(o.k === '__sin' ? 'Sin ruta' : o.k)} <a href="#" data-pfx="${esc(o.k)}" style="color:inherit;text-decoration:none;margin-left:4px">×</a></span>`).join('') : ''}
    <span class="note" style="margin-left:auto">${vis === total ? `${total} pedidos` : `Mostrando ${vis} de ${total} pedidos`}</span>`;
  const d = el.querySelector('details'); if (abierto) d.open = true;
  const aplicar = () => { pedFGuardar(); render(); };
  el.querySelectorAll('[data-pf]').forEach(b => b.onclick = e => { e.preventDefault(); PEDF.sel = b.dataset.pf === 'todas' ? null : new Set(); aplicar(); });
  el.querySelectorAll('[data-pfr]').forEach(x => x.onchange = () => { const s = PEDF.sel ? new Set(PEDF.sel) : new Set(ops.map(o => o.k)); x.checked ? s.add(x.dataset.pfr) : s.delete(x.dataset.pfr); PEDF.sel = ops.every(o => s.has(o.k)) ? null : s; aplicar(); });
  el.querySelectorAll('[data-pfx]').forEach(a => a.onclick = e => { e.preventDefault(); const s = new Set(PEDF.sel || []); s.delete(a.dataset.pfx); PEDF.sel = s.size ? s : null; aplicar(); });
}
document.addEventListener('click', e => { if (!e.target.isConnected) return; /* el clic redibujó el filtro */ const d = document.querySelector('#ped-filtro details[open]'); if (d && !d.contains(e.target)) d.open = false; });
