/* DGP · Flota para la planificación y simulación animada del llenado y del recorrido.
   - Cada vehículo tiene estado activo / inactivo (vehiculos.activo, se guarda en la base y se audita).
   - De los activos, el planificador marca cuáles se usan hoy (por defecto todos). La selección se recuerda en este navegador.
   - El motor de rutas (planificar en app.js) solo usa los vehículos activos y seleccionados.
   - Simulación: por ruta de Zoho, cada camión se llena pedido por pedido (orden de carga = inverso de la entrega)
     mostrando lo que queda libre; después recorre la ruta y descarga en cada parada. */
const FLOTA = {
  excl: (() => { try { return new Set(JSON.parse(localStorage.getItem('dgp_plan_excluir') || '[]')); } catch (e) { return new Set(); } })(),
  sim: { abierta: false, grupo: '__todas', vel: 1, token: 0, fase: 'lista' }
};
const usarEnPlan = v => v && v.activo !== false && !FLOTA.excl.has(v.id);
function guardarExcl() { try { localStorage.setItem('dgp_plan_excluir', JSON.stringify([...FLOTA.excl])); } catch (e) { /* sin almacenamiento: solo esta sesión */ } }
const SIM_REDUCIR = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
const simEspera = ms => new Promise(r => setTimeout(r, SIM_REDUCIR() ? 0 : ms / FLOTA.sim.vel));
const rutaViva = r => !['cerrada', 'conciliada'].includes(r.estado);
const n0 = x => (+x || 0).toLocaleString('es-PA', { maximumFractionDigits: 0 });
const n2 = x => (+x || 0).toLocaleString('es-PA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ---------- Panel de flota ---------- */
function renderFlotaPlan() {
  const box = $('plan-flota-card'); if (!box) return;
  const vs = S.vehiculos.slice().sort((a, b) => (a.activo === false) - (b.activo === false) || +b.cap_cajas - +a.cap_cajas || String(a.placa).localeCompare(b.placa));
  const act = vs.filter(v => v.activo !== false), sel = act.filter(usarEnPlan);
  const tot = sel.reduce((t, v) => ({ cajas: t.cajas + (+v.cap_cajas || 0), kg: t.kg + (+v.cap_peso_kg || 0), m3: t.m3 + (+v.cap_volumen_m3 || 0) }), { cajas: 0, kg: 0, m3: 0 });
  const edita = puede('catalogo.editar');
  const uso = v => S.rutas.filter(r => r.vehiculo_id === v.id && rutaViva(r));
  const tile = v => {
    const on = v.activo !== false, us = usarEnPlan(v), rs = uso(v);
    const pub = rs.find(r => r.estado !== 'simulada'), prop = rs.find(r => r.estado === 'simulada');
    const fill = r => Math.round(llenadoDe(r, v) * 100);
    const estado = !on ? '<span class="pill p-mut nodot">Inactivo</span>' : pub ? `<span class="pill p-info nodot" title="Ya publicado: no entra en una nueva propuesta">${esc(pub.codigo)} · ${rpillTxt(pub.estado)}</span>` : prop ? `<span class="pill ${fill(prop) > 100 ? 'p-crit' : 'p-ok'} nodot">${esc(prop.codigo)} · ${fill(prop)} % lleno</span>` : us ? '<span class="pill p-ok nodot">Disponible</span>' : '<span class="pill p-warn nodot">No se usa hoy</span>';
    return `<div class="ft ${on ? '' : 'off'} ${on && !us ? 'nouse' : ''}" style="--vc:${v.color || '#64748B'}">
      <div class="ft-hd"><span class="swatch" style="background:${v.color || '#64748B'}"></span><div style="min-width:0"><b>${esc(v.placa)}</b> <span class="mini">${esc(tipoVeh(v.tipo))}</span><div class="mini ell">${esc(v.nombre || '')}${v.conductor ? ' · ' + esc(v.conductor) : ''}</div></div>${estado}</div>
      <div class="ft-cap"><span title="Cajas"><b>${n0(v.cap_cajas)}</b> cajas</span><span title="Peso máximo"><b>${n0(v.cap_peso_kg)}</b> kg</span><span title="Volumen"><b>${(+v.cap_volumen_m3 || 0).toLocaleString('es-PA', { maximumFractionDigits: 2 })}</b> m³</span><span title="Venta mínima de la ruta"><b>B/. ${n0(minimoDe(v))}</b> mín.</span></div>
      <div class="ft-ft">
        <label class="sw" title="${edita ? 'Activo / inactivo en la flota (se guarda para todos)' : 'Solo quien edita catálogos cambia el estado'}"><input type="checkbox" data-fact="${v.id}" ${on ? 'checked' : ''} ${edita ? '' : 'disabled'}><i></i><span>${on ? 'Activo' : 'Inactivo'}</span></label>
        <label class="chk ${on ? '' : 'dis'}"><input type="checkbox" data-fuse="${v.id}" ${us ? 'checked' : ''} ${on ? '' : 'disabled'}> Usar en la propuesta</label>
        ${edita ? `<button class="btn xs sec" data-fcap="${v.id}">Capacidad</button>` : ''}
      </div></div>`;
  };
  box.innerHTML = `<div class="hd"><div><h2>Flota para esta planificación</h2><div class="sub">Todos los vehículos con su capacidad. Solo los <b>activos</b> pueden usarse; de ellos, marca cuáles entran en la propuesta (por defecto, todos). El estado activo se guarda en la base; la selección de hoy, en este navegador.</div></div>
    <div class="row"><button class="btn xs sec" id="fl-todos">Usar todos los activos</button><button class="btn xs sec" id="fl-ninguno">Ninguno</button></div></div>
    <div class="ft-sum"><span><b>${act.length}</b> activos de ${vs.length}</span><span><b>${sel.length}</b> en la propuesta</span><span>Capacidad seleccionada: <b>${n0(tot.cajas)}</b> cajas · <b>${n0(tot.kg)}</b> kg · <b>${tot.m3.toLocaleString('es-PA', { maximumFractionDigits: 1 })}</b> m³</span></div>
    <div class="ft-grid">${vs.map(tile).join('') || '<div class="empty">No hay vehículos en el catálogo.</div>'}</div>`;
  box.querySelectorAll('[data-fuse]').forEach(c => c.onchange = () => { if (c.checked) FLOTA.excl.delete(c.dataset.fuse); else FLOTA.excl.add(c.dataset.fuse); guardarExcl(); renderFlotaPlan(); notaFlota(); });
  box.querySelectorAll('[data-fact]').forEach(c => c.onchange = () => cambiarActivo(c.dataset.fact, c.checked, c));
  box.querySelectorAll('[data-fcap]').forEach(b => b.onclick = () => editarCapacidad(b.dataset.fcap));
  $('fl-todos').onclick = () => { act.forEach(v => FLOTA.excl.delete(v.id)); guardarExcl(); renderFlotaPlan(); notaFlota(); };
  $('fl-ninguno').onclick = () => { act.forEach(v => FLOTA.excl.add(v.id)); guardarExcl(); renderFlotaPlan(); notaFlota(); };
  notaFlota();
  const bs = $('b-sim'); if (bs) bs.disabled = !S.rutas.some(r => rutaViva(r) && S.pedidos.some(p => p.ruta_id === r.id));
  if (FLOTA.sim.abierta && FLOTA.sim.fase !== 'corriendo') simPintar(false);
}
const rpillTxt = e => ({ simulada: 'propuesta', pendiente_autorizacion: 'por autorizar', autorizada: 'autorizada', publicada: 'publicada', liberada: 'liberada', en_ruta: 'en ruta' }[e] || e);
function notaFlota() {
  const el = $('plan-flota'); if (!el) return;
  const pub = new Set(S.rutas.filter(r => r.estado !== 'simulada' && rutaViva(r)).map(r => r.vehiculo_id));
  const act = S.vehiculos.filter(v => v.activo !== false), sel = act.filter(usarEnPlan);
  el.textContent = `Flota activa ${act.length} · en la propuesta ${sel.length} · libres para planificar ${sel.filter(v => !pub.has(v.id)).length} · mínimo de venta: panel B/. ${fmt(R('minimo_ruta').panel || 2500)}, camión B/. ${fmt(R('minimo_ruta').camion || 5000)}`;
}
async function cambiarActivo(id, activo, input) {
  if (!exige('catalogo.editar')) { input.checked = !activo; return; }
  const v = veh(id); if (!v) return;
  const prop = S.rutas.filter(r => r.vehiculo_id === id && r.estado === 'simulada');
  const pub = S.rutas.filter(r => r.vehiculo_id === id && r.estado !== 'simulada' && rutaViva(r));
  if (!activo && pub.length && !confirm(`${v.placa} tiene rutas ya publicadas (${pub.map(r => r.codigo).join(', ')}). Esas rutas no cambian; solo deja de usarse en propuestas nuevas. ¿Desactivar?`)) { input.checked = true; return; }
  await DB.update('vehiculos', { id }, { activo });
  await DB.audit('vehiculos', activo ? 'activado' : 'desactivado', `${v.placa} ${v.nombre || ''}: ${activo ? 'activo' : 'inactivo'} para planificar`, ACTOR, false, id);
  if (activo) FLOTA.excl.delete(id); guardarExcl();
  toast(`${v.placa} ${activo ? 'activo' : 'inactivo'}${!activo && prop.length ? ' · está en la propuesta actual: vuelve a generarla' : ''}`);
  await loadAll(); render();
}
function editarCapacidad(id) {
  const v = veh(id); if (!v || !exige('catalogo.editar')) return;
  const f = (k, l, step) => `<label class="mini" style="display:block">${l}<input id="fc-${k}" type="number" min="0" step="${step}" value="${v[k] ?? ''}" style="width:100%"></label>`;
  modal(`<h2 style="margin-bottom:4px">Capacidad de ${esc(v.placa)}</h2><p class="mini" style="margin-top:0">${esc(v.nombre || '')} · ${esc(tipoVeh(v.tipo))}. El motor llena el vehículo hasta el primero de estos límites que se alcance.</p>
    <div class="grid g2" style="gap:10px">${f('cap_cajas', 'Cajas', 1)}${f('cap_peso_kg', 'Peso máximo (kg)', 1)}${f('cap_volumen_m3', 'Volumen (m³)', 0.1)}${f('min_valor', 'Venta mínima de la ruta (B/.) · vacío = regla general', 1)}</div>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn sec" onclick="closeModal()">Cancelar</button><button class="btn" id="fc-ok">Guardar</button></div>`);
  $('fc-ok').onclick = async () => {
    const val = k => { const x = $('fc-' + k).value; return x === '' ? null : +x; };
    const nv = { cap_cajas: val('cap_cajas'), cap_peso_kg: val('cap_peso_kg'), cap_volumen_m3: val('cap_volumen_m3'), min_valor: val('min_valor') };
    if (['cap_cajas', 'cap_peso_kg', 'cap_volumen_m3'].some(k => nv[k] == null || nv[k] < 0)) { toast('Cajas, peso y volumen son obligatorios y no pueden ser negativos'); return; }
    if (nv.cap_cajas != null) nv.cap_cajas = Math.round(nv.cap_cajas);
    const antes = `${v.cap_cajas} cajas/${v.cap_peso_kg} kg/${v.cap_volumen_m3} m³/mín ${v.min_valor ?? 'regla'}`;
    await DB.update('vehiculos', { id }, nv);
    await DB.audit('vehiculos', 'capacidad', `${v.placa}: ${antes} → ${nv.cap_cajas} cajas/${nv.cap_peso_kg} kg/${nv.cap_volumen_m3} m³/mín ${nv.min_valor ?? 'regla'}`, ACTOR, false, id);
    closeModal(); toast('Capacidad guardada. Vuelve a generar la propuesta para aplicarla.'); await loadAll(); render();
  };
}

/* ---------- Datos de la simulación ---------- */
function capDe(v) { return { cajas: +v.cap_cajas || 0, peso: +v.cap_peso_kg || 0, vol: +v.cap_volumen_m3 || 0 }; }
function fraccion(t, cap) { return Math.max(cap.cajas ? t.cajas / cap.cajas : 0, cap.peso ? t.peso_kg / cap.peso : 0, cap.vol ? t.volumen_m3 / cap.vol : 0); }
function llenadoDe(r, v) { return fraccion(totalesDe(S.pedidos.filter(p => p.ruta_id === r.id)), capDe(v || veh(r.vehiculo_id) || {})); }
function viajeSim(r) {
  const v = veh(r.vehiculo_id) || {}; const cap = capDe(v);
  const st = S.paradas.filter(p => p.ruta_id === r.id && p.tipo === 'entrega').sort((a, b) => a.secuencia - b.secuencia);
  let entrega = st.map(s => ({ s, p: S.pedidos.find(x => x.id === s.pedido_id) })).filter(x => x.p);
  S.pedidos.filter(p => p.ruta_id === r.id && !entrega.some(x => x.p.id === p.id)).forEach(p => entrega.push({ s: null, p }));
  const carga = entrega.slice().reverse();                       // se carga primero lo que se entrega último (sale por la puerta al final)
  let acc = { valor: 0, peso_kg: 0, volumen_m3: 0, cajas: 0 }, prev = 0;
  const pasos = carga.map((x, i) => {
    acc = { valor: acc.valor + +x.p.valor, peso_kg: acc.peso_kg + +x.p.peso_kg, volumen_m3: acc.volumen_m3 + +x.p.volumen_m3, cajas: acc.cajas + +x.p.cajas };
    const f = fraccion(acc, cap); const paso = { i, p: x.p, s: x.s, c: cli(x.p.cliente_id) || {}, acc: Object.assign({}, acc), f, ancho: Math.max(0, f - prev) }; prev = f; return paso;
  });
  const lim = !pasos.length ? '' : (() => { const t = pasos[pasos.length - 1].acc; const d = [['cajas', cap.cajas ? t.cajas / cap.cajas : 0], ['peso', cap.peso ? t.peso_kg / cap.peso : 0], ['volumen', cap.vol ? t.volumen_m3 / cap.vol : 0]].sort((a, b) => b[1] - a[1]); return d[0][0]; })();
  return { r, v, cap, pasos, final: prev, lim, entrega };
}
function gruposSim() {
  const rs = S.rutas.filter(r => rutaViva(r) && S.pedidos.some(p => p.ruta_id === r.id));
  return gruposRuta(rs);
}

/* ---------- Pintado ---------- */
function simAbrir(auto) {
  const c = $('plan-sim'); if (!c) return;
  if (!gruposSim().length) { toast('Genera la propuesta primero'); return; }
  FLOTA.sim.abierta = true; c.style.display = '';
  simPintar(false);
  c.scrollIntoView({ behavior: SIM_REDUCIR() ? 'auto' : 'smooth', block: 'start' });
  if (auto) simCargar();
}
function simPintar(vacio) {
  const c = $('plan-sim'); if (!c) return;
  const gs = gruposSim(); if (!gs.length) { c.style.display = 'none'; FLOTA.sim.abierta = false; return; }
  if (FLOTA.sim.grupo !== '__todas' && !gs.some(g => g.z === FLOTA.sim.grupo)) FLOTA.sim.grupo = '__todas';
  const vis = FLOTA.sim.grupo === '__todas' ? gs : gs.filter(g => g.z === FLOTA.sim.grupo);
  const usados = new Set(S.rutas.filter(rutaViva).map(r => r.vehiculo_id));
  const sinCarga = S.vehiculos.filter(v => usarEnPlan(v) && !usados.has(v.id));
  const vel = FLOTA.sim.vel;
  c.innerHTML = `<div class="hd"><div><h2>Simulación: llenado de camiones y recorrido</h2><div class="sub">Cada camión se llena pedido por pedido en el orden de carga (primero lo que se entrega de último). La barra muestra el espacio usado según el límite que se alcanza antes (cajas, peso o volumen) y lo que queda libre. Después el camión recorre la ruta y descarga en cada parada.</div></div>
    <div class="row"><button class="btn sm" id="sim-cargar">▶ Cargar camiones</button><button class="btn sm info" id="sim-rec">🚚 Recorrer ruta</button><button class="btn sm sec" id="sim-fin">Ver resultado</button>
    <label class="mini">Velocidad <select class="xs" id="sim-vel">${[0.5, 1, 2, 4].map(x => `<option value="${x}" ${x === vel ? 'selected' : ''}>${x}×</option>`).join('')}</select></label><button class="btn sm sec" id="sim-x" title="Cerrar simulación">✕</button></div></div>
    <div class="tabs" id="sim-tabs"><button data-g="__todas" class="${FLOTA.sim.grupo === '__todas' ? 'on' : ''}">Todas las rutas</button>${gs.map(g => `<button data-g="${esc(g.z)}" class="${FLOTA.sim.grupo === g.z ? 'on' : ''}"><span class="swatch" style="background:${g.zona.color || '#64748B'}"></span>${esc((g.zona.nombre || g.z).split(' ·')[0])}</button>`).join('')}</div>
    ${vis.map(g => `<div class="sim-grupo">${cabeceraRuta(g)}<div class="sim-trips">${g.rutas.map(r => tarjetaSim(viajeSim(r), g, vacio)).join('')}</div></div>`).join('')}
    ${sinCarga.length ? `<div class="sim-grupo"><div class="grupo-ruta" style="display:flex;gap:10px;align-items:center;margin:14px 0 2px;padding:8px 12px;border-left:6px solid #94A3B8;background:#94A3B814;border-radius:8px"><b>Vehículos seleccionados sin carga</b><span class="mini">quedan libres hoy</span></div><div class="sim-trips">${sinCarga.map(v => `<div class="sim-trip libre" style="--vc:${v.color || '#94A3B8'}"><div class="sim-th"><b>${esc(v.placa)}</b> <span class="mini">${esc(tipoVeh(v.tipo))} · ${esc(v.conductor || '')}</span></div>${camion({ v, cap: capDe(v), pasos: [], final: 0 }, true)}<div class="sim-left">Libre: <b>${n0(v.cap_cajas)}</b> cajas · <b>${n0(v.cap_peso_kg)}</b> kg · <b>${(+v.cap_volumen_m3 || 0).toLocaleString('es-PA', { maximumFractionDigits: 2 })}</b> m³</div></div>`).join('')}</div></div>` : ''}`;
  $('sim-cargar').onclick = () => simCargar(); $('sim-rec').onclick = () => simRecorrer(); $('sim-fin').onclick = () => { FLOTA.sim.token++; FLOTA.sim.fase = 'lista'; simPintar(false); };
  $('sim-vel').onchange = e => { FLOTA.sim.vel = +e.target.value; };
  $('sim-x').onclick = () => { FLOTA.sim.token++; FLOTA.sim.fase = 'lista'; FLOTA.sim.abierta = false; c.style.display = 'none'; c.innerHTML = ''; };
  c.querySelectorAll('#sim-tabs [data-g]').forEach(b => b.onclick = () => { FLOTA.sim.token++; FLOTA.sim.fase = 'lista'; FLOTA.sim.grupo = b.dataset.g; simPintar(false); });
}
function camion(t, vacio) {
  const esc100 = Math.max(1, t.final);                          // si se pasa del 100 %, el contenedor se encoge para que se vea el exceso
  const anchoCaja = 100 / esc100;
  const bloques = t.pasos.map(x => {
    const ini = x.f - x.ancho, sobre = x.f > 1 + 1e-9;
    return `<i class="blk ${sobre ? 'over' : ''} ${vacio ? 'pend' : ''}" data-blk="${x.p.id}" style="right:${(ini / esc100) * 100}%;width:${Math.max(0.6, (x.ancho / esc100) * 100)}%;--h:${(x.i * 47) % 360}" title="${esc(x.p.numero_factura || x.p.numero_so)} · ${esc(x.c.nombre || '')} · ${x.p.cajas} cajas · ${f1(x.p.peso_kg)} kg"><span>${x.ancho / esc100 > 0.07 ? esc((x.p.numero_factura || x.p.numero_so || '').slice(-6)) : ''}</span></i>`;
  }).join('');
  const pct = Math.round((vacio ? 0 : t.final) * 100);
  return `<div class="truck ${pct > 100 ? 'excede' : ''}"><div class="t-body"><div class="t-box"><div class="t-lim" style="width:${anchoCaja}%"></div>${bloques}<b class="t-pct">${pct} %</b></div><div class="t-cab"><i></i></div></div><div class="t-wheels"><i></i><i></i><i></i></div></div>`;
}
function medidores(t, acc) {
  const b = (l, x, m, u, dec) => { const pc = m ? Math.min(100, x / m * 100) : 0; const q = m - x; return `<div><div class="cap"><span>${l} <span class="code">${dec ? n2(x) : n0(x)}/${dec ? n2(m) : n0(m)}${u ? ' ' + u : ''}</span></span><b class="code ${q < 0 ? 'neg' : ''}">${q < 0 ? 'excede ' + (dec ? n2(-q) : n0(-q)) : 'queda ' + (dec ? n2(q) : n0(q))}</b></div><div class="bar ${pc >= 100 ? 'c' : pc >= 85 ? 'w' : ''}"><i style="width:${pc}%"></i></div></div>`; };
  return `${b('Cajas', acc.cajas, t.cap.cajas, '', false)}${b('Peso', acc.peso_kg, t.cap.peso, 'kg', false)}${b('Volumen', acc.volumen_m3, t.cap.vol, 'm³', true)}`;
}
function tarjetaSim(t, g, vacio) {
  const r = t.r, v = t.v; const fin = t.pasos.length ? t.pasos[t.pasos.length - 1].acc : { cajas: 0, peso_kg: 0, volumen_m3: 0, valor: 0 };
  const acc = vacio ? { cajas: 0, peso_kg: 0, volumen_m3: 0, valor: 0 } : fin;
  const min = +r.minimo || minimoDe(v);
  return `<div class="sim-trip" id="st-${r.id}" style="--vc:${r.color || v.color || '#64748B'}">
    <div class="sim-th"><span class="swatch" style="background:${r.color || v.color}"></span><b>${esc(r.codigo)}</b> <span class="mini">${esc(viajeDe(g, r))} · ${esc(v.placa || '')} ${esc(tipoVeh(v.tipo))} · ${esc(r.conductor || '')}</span><span class="sim-st" data-st>${vacio ? 'en bodega' : t.final > 1 ? 'excede capacidad' : 'cargado'}</span></div>
    <div class="sim-stage">${camion(t, vacio)}<div class="sim-meters" data-met>${medidores(t, acc)}</div></div>
    <div class="sim-left" data-left>${resumenQueda(t, acc, min, vacio)}</div>
    <div class="sim-cols"><div class="sim-list"><div class="mini sim-cap">Orden de carga (pedido por pedido)</div><ol>${t.pasos.map(x => `<li class="${vacio ? '' : 'on'}" data-row="${x.p.id}"><span class="k">${x.i + 1}</span><span class="nm"><b>${esc(x.p.numero_factura || x.p.numero_so)}</b> ${esc((x.c.nombre || '').slice(0, 30))}${x.s ? ` <span class="mini">· entrega #${x.s.secuencia}${x.s.eta ? ' ' + x.s.eta : ''}</span>` : ''}</span><span class="code">${n0(x.p.cajas)} cj · ${n0(x.p.peso_kg)} kg</span><span class="code fl ${x.f > 1 ? 'neg' : ''}">${Math.round(x.f * 100)} %</span></li>`).join('')}</ol></div>
    <div class="sim-map" data-map>${mapaSim(t)}</div></div></div>`;
}
function resumenQueda(t, acc, min, vacio, hechos) {
  const q = { cajas: t.cap.cajas - acc.cajas, kg: t.cap.peso - acc.peso_kg, m3: t.cap.vol - acc.volumen_m3 };
  const pct = Math.round(fraccion(acc, t.cap) * 100);
  const venta = vacio ? '' : acc.valor >= min ? `<span class="pill p-ok nodot">venta B/. ${fmt(acc.valor)} ≥ mínimo</span>` : `<span class="pill p-warn nodot">venta B/. ${fmt(acc.valor)} · faltan B/. ${fmt(min - acc.valor)} para el mínimo</span>`;
  const cnt = vacio ? 0 : hechos ?? t.pasos.length;
  return `<span>${cnt} de ${t.pasos.length} pedidos · <b>${pct} %</b> ocupado${t.lim && !vacio ? ` (lo limita ${t.lim})` : ''}</span><span>Queda libre: <b class="${q.cajas < 0 ? 'neg' : ''}">${n0(q.cajas)}</b> cajas · <b class="${q.kg < 0 ? 'neg' : ''}">${n0(q.kg)}</b> kg · <b class="${q.m3 < 0 ? 'neg' : ''}">${n2(q.m3)}</b> m³</span>${venta}`;
}
/* Mini mapa SVG del recorrido: calle (OSRM) si existe, paradas numeradas y bodega */
function proyeccion(t) {
  const B = S.bodega || {}; const st = t.entrega.filter(x => x.s && x.s.lat != null && !isNaN(+x.s.lat)).map(x => x.s);
  const geo = (t.r.geometria || []).filter(p => p && p[0] != null);
  const pts = [[+B.lat, +B.lng], ...st.map(s => [+s.lat, +s.lng]), ...geo.map(p => [+p[0], +p[1]])].filter(p => !isNaN(p[0]) && !isNaN(p[1]));
  if (pts.length < 2 || isNaN(+B.lat)) return null;
  const W = 320, H = 200, pad = 16; const lat0 = pts.reduce((s, p) => s + p[0], 0) / pts.length; const kx = Math.cos(lat0 * Math.PI / 180);
  const xs = pts.map(p => p[1] * kx), ys = pts.map(p => p[0]); const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const k = Math.min((W - 2 * pad) / Math.max(maxX - minX, 1e-6), (H - 2 * pad) / Math.max(maxY - minY, 1e-6));
  const ox = (W - (maxX - minX) * k) / 2, oy = (H - (maxY - minY) * k) / 2;
  const P = (lat, lng) => [ox + (lng * kx - minX) * k, oy + (maxY - lat) * k];
  const b = P(+B.lat, +B.lng); const sp = st.map(s => ({ s, xy: P(+s.lat, +s.lng) }));
  // camino del camión: la geometría de calle si hay; si no, líneas rectas bodega → paradas → bodega
  let camino, idx;
  if (geo.length > 1) {
    camino = geo.map(p => P(+p[0], +p[1])); let desde = 0;
    idx = sp.map(x => { let best = desde, bd = Infinity; for (let i = desde; i < camino.length; i++) { const d = (camino[i][0] - x.xy[0]) ** 2 + (camino[i][1] - x.xy[1]) ** 2; if (d < bd) { bd = d; best = i; } } desde = best; return best; });
  } else { camino = [b, ...sp.map(x => x.xy), b]; idx = sp.map((_, i) => i + 1); }
  return { W, H, b, sp, camino, idx };
}
function mapaSim(t) {
  const m = proyeccion(t); if (!m) return '<div class="mini sim-nomap">Sin coordenadas suficientes para dibujar el recorrido.</div>';
  const col = t.r.color || t.v.color || '#2563EB'; const d = m.camino.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  return `<svg viewBox="0 0 ${m.W} ${m.H}" class="sim-svg" role="img" aria-label="Recorrido de ${esc(t.r.codigo)}"><rect width="${m.W}" height="${m.H}" rx="10" fill="#F1F5F9"/>
    <path d="${d}" fill="none" stroke="${col}" stroke-opacity=".28" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path data-trail d="M${m.b[0]} ${m.b[1]}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    ${m.sp.map((x, i) => `<g data-stop="${x.s.pedido_id || i}" class="stp"><circle cx="${x.xy[0].toFixed(1)}" cy="${x.xy[1].toFixed(1)}" r="7" fill="#fff" stroke="${col}" stroke-width="2"/><text x="${x.xy[0].toFixed(1)}" y="${(x.xy[1] + 3).toFixed(1)}" text-anchor="middle" font-size="8" font-weight="700" fill="#0F172A">${x.s.secuencia}</text></g>`).join('')}
    <rect x="${m.b[0] - 7}" y="${m.b[1] - 7}" width="14" height="14" rx="3" fill="#0F172A"/><text x="${m.b[0]}" y="${m.b[1] + 3}" text-anchor="middle" font-size="8" fill="#fff" font-weight="700">B</text>
    <g data-truck transform="translate(${m.b[0]} ${m.b[1]})" style="display:none"><circle r="9" fill="${col}" stroke="#fff" stroke-width="2.5"/><path d="M-4.5 -2.5h5v5h-5z M0.5 -1h2.5l1.5 1.8v1.7h-4z" fill="#fff"/></g>
    <text data-clock x="10" y="18" font-size="11" font-family="JetBrains Mono,monospace" font-weight="700" fill="#0F172A">${esc(t.r.hora_salida || '07:00')}</text></svg>`;
}

/* ---------- Animaciones ---------- */
async function simCargar() {
  const tok = ++FLOTA.sim.token; FLOTA.sim.fase = 'corriendo'; simPintar(true);
  const gs = gruposSim(); const vis = FLOTA.sim.grupo === '__todas' ? gs : gs.filter(g => g.z === FLOTA.sim.grupo);
  const trips = vis.flatMap(g => g.rutas.map(r => viajeSim(r)));
  await Promise.all(trips.map((t, k) => cargarUno(t, tok, k * 180)));
  if (tok === FLOTA.sim.token) { FLOTA.sim.fase = 'cargado'; toast('Camiones cargados. Pulsa «Recorrer ruta» para ver la entrega.'); }
}
async function cargarUno(t, tok, retardo) {
  const card = $('st-' + t.r.id); if (!card) return; await simEspera(retardo); if (tok !== FLOTA.sim.token) return;
  const min = +t.r.minimo || minimoDe(t.v); const st = card.querySelector('[data-st]'); st.textContent = 'cargando…'; card.classList.add('activo');
  const pausa = Math.max(120, Math.min(650, 5200 / Math.max(1, t.pasos.length)));
  for (const x of t.pasos) {
    if (tok !== FLOTA.sim.token) return;
    const blk = card.querySelector(`[data-blk="${x.p.id}"]`); if (blk) { blk.classList.remove('pend'); blk.classList.add('drop'); }
    const row = card.querySelector(`[data-row="${x.p.id}"]`); if (row) { row.classList.add('on', 'hit'); setTimeout(() => row.classList.remove('hit'), 700 / FLOTA.sim.vel); const ol = row.parentElement; ol.scrollTop = row.offsetTop - ol.offsetTop - 40; }
    card.querySelector('.t-pct').textContent = Math.round(x.f * 100) + ' %';
    if (x.f > 1) card.querySelector('.truck').classList.add('excede');
    card.querySelector('[data-met]').innerHTML = medidores(t, x.acc);
    card.querySelector('[data-left]').innerHTML = resumenQueda(t, x.acc, min, false, x.i + 1);
    card.querySelector('.truck').classList.remove('bump'); void card.offsetWidth; card.querySelector('.truck').classList.add('bump');
    await simEspera(pausa);
  }
  st.textContent = t.final > 1 ? 'excede capacidad' : `cargado · ${Math.round(t.final * 100)} %`; card.classList.remove('activo');
}
async function simRecorrer() {
  if (FLOTA.sim.fase !== 'cargado') { FLOTA.sim.token++; FLOTA.sim.fase = 'lista'; simPintar(false); }
  const tok = ++FLOTA.sim.token; FLOTA.sim.fase = 'corriendo';
  const gs = gruposSim(); const vis = FLOTA.sim.grupo === '__todas' ? gs : gs.filter(g => g.z === FLOTA.sim.grupo);
  await Promise.all(vis.flatMap(g => g.rutas.map(r => viajeSim(r))).map((t, k) => recorrerUno(t, tok, k * 250)));
  if (tok === FLOTA.sim.token) { FLOTA.sim.fase = 'lista'; toast('Recorrido simulado completo'); }
}
function animarCamino(svgTruck, trail, camino, a, b, ms, tok) {
  return new Promise(res => {
    if (b <= a || SIM_REDUCIR()) { const p = camino[b] || camino[a]; svgTruck.setAttribute('transform', `translate(${p[0]} ${p[1]})`); trail.setAttribute('d', trail.getAttribute('d') + camino.slice(a + 1, b + 1).map(q => ` L${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join('')); return res(); }
    const seg = []; let L = 0; for (let i = a; i < b; i++) { const d = Math.hypot(camino[i + 1][0] - camino[i][0], camino[i + 1][1] - camino[i][1]); seg.push(d); L += d; }
    const base = trail.getAttribute('d'); const t0 = performance.now(); const dur = ms / FLOTA.sim.vel;
    const paso = now => {
      if (tok !== FLOTA.sim.token) return res();
      const k = Math.min(1, (now - t0) / dur); let objetivo = L * k, i = 0; while (i < seg.length - 1 && objetivo > seg[i]) { objetivo -= seg[i]; i++; }
      const p0 = camino[a + i], p1 = camino[a + i + 1], u = seg[i] ? Math.min(1, objetivo / seg[i]) : 1;
      const x = p0[0] + (p1[0] - p0[0]) * u, y = p0[1] + (p1[1] - p0[1]) * u;
      svgTruck.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
      trail.setAttribute('d', base + camino.slice(a + 1, a + i + 1).map(q => ` L${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join('') + ` L${x.toFixed(1)} ${y.toFixed(1)}`);
      if (k < 1) requestAnimationFrame(paso); else { trail.setAttribute('d', base + camino.slice(a + 1, b + 1).map(q => ` L${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join('')); res(); }
    };
    requestAnimationFrame(paso);
  });
}
async function recorrerUno(t, tok, retardo) {
  const card = $('st-' + t.r.id); if (!card) return; await simEspera(retardo); if (tok !== FLOTA.sim.token) return;
  const m = proyeccion(t); const svg = card.querySelector('.sim-svg'); const st = card.querySelector('[data-st]'); card.classList.add('activo');
  const min = +t.r.minimo || minimoDe(t.v);
  let abordo = t.pasos.length ? Object.assign({}, t.pasos[t.pasos.length - 1].acc) : { cajas: 0, peso_kg: 0, volumen_m3: 0, valor: 0 };
  const truck = svg && svg.querySelector('[data-truck]'), trail = svg && svg.querySelector('[data-trail]'), clock = svg && svg.querySelector('[data-clock]');
  if (truck) truck.style.display = '';
  card.querySelector('.truck').classList.add('rueda');
  let pos = 0; const conCoord = m ? m.sp.map(x => x.s.pedido_id) : [];
  st.textContent = 'en ruta…';
  for (const x of t.entrega) {
    if (tok !== FLOTA.sim.token) return;
    const j = conCoord.indexOf(x.p.id);
    if (truck && j >= 0) { const dest = m.idx[j]; const km = +(x.s && x.s.km_tramo) || 3; await animarCamino(truck, trail, m.camino, pos, Math.max(pos, dest), Math.max(450, Math.min(1800, km * 120)), tok); pos = Math.max(pos, dest); const g = svg.querySelector(`[data-stop="${x.p.id}"]`); if (g) g.classList.add('ok'); }
    else await simEspera(350);
    if (tok !== FLOTA.sim.token) return;
    if (clock && x.s && x.s.eta) clock.textContent = x.s.eta;
    const blk = card.querySelector(`[data-blk="${x.p.id}"]`); if (blk) { blk.classList.remove('drop'); blk.classList.add('out'); }
    const row = card.querySelector(`[data-row="${x.p.id}"]`); if (row) { row.classList.add('entregado'); const ol = row.parentElement; ol.scrollTop = row.offsetTop - ol.offsetTop - 40; }
    abordo = { cajas: abordo.cajas - +x.p.cajas, peso_kg: abordo.peso_kg - +x.p.peso_kg, volumen_m3: abordo.volumen_m3 - +x.p.volumen_m3, valor: abordo.valor - +x.p.valor };
    card.querySelector('.t-pct').textContent = Math.round(Math.max(0, fraccion(abordo, t.cap)) * 100) + ' %';
    card.querySelector('[data-met]').innerHTML = medidores(t, abordo);
    const hechas = t.entrega.indexOf(x) + 1;
    card.querySelector('[data-left]').innerHTML = `<span>Entregados ${hechas} de ${t.entrega.length}${x.s && x.s.eta ? ' · ETA ' + x.s.eta : ''} · ${esc((cli(x.p.cliente_id) || {}).nombre || '')}</span><span>A bordo: <b>${n0(abordo.cajas)}</b> cajas · <b>${n0(abordo.peso_kg)}</b> kg</span>`;
    await simEspera(260);
  }
  if (truck && m) await animarCamino(truck, trail, m.camino, pos, m.camino.length - 1, 900, tok);
  if (tok !== FLOTA.sim.token) return;
  if (clock && t.r.hora_fin_prevista) clock.textContent = t.r.hora_fin_prevista;
  card.querySelector('.truck').classList.remove('rueda'); card.classList.remove('activo');
  st.textContent = `de regreso ${t.r.hora_fin_prevista || ''} · ${f1(t.r.km_plan)} km`;
  card.querySelector('[data-left]').innerHTML = `<span>Ruta completa: ${t.entrega.length} entregas · ${f1(t.r.km_plan)} km · regreso ${esc(t.r.hora_fin_prevista || '—')}</span>${t.pasos.length ? (t.pasos[t.pasos.length - 1].acc.valor >= min ? '<span class="pill p-ok nodot">cumple mínimo de venta</span>' : '<span class="pill p-warn nodot">bajo el mínimo de venta</span>') : ''}`;
}
if ($('b-sim')) $('b-sim').onclick = () => simAbrir(false);
window.usarEnPlan = usarEnPlan; window.renderFlotaPlan = renderFlotaPlan; window.simAbrir = simAbrir;
