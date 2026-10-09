/* DGP · Módulo de usuarios, roles y permisos (v3).
   Usuarios: alta, edición, activación, contraseña temporal (Edge Function "usuarios", con service_role en el servidor).
   Roles y permisos: matriz editable (tabla rol_permisos, protegida por RLS con roles.gestionar).
   Registro de seguridad: cambios de perfiles, matriz y reglas sellados por el servidor. */
window.USR = (function () {
  const U = { tab: 'usuarios', perfiles: [], roles: [], permisos: [], rp: [], auth: {}, filtro: '', cargado: false };
  const enProd = () => window.Auth && Auth.activo;
  const fechaH = t => t ? new Date(t).toLocaleString('es-PA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

  async function cargar() {
    const [perfiles, roles, permisos, rp] = await Promise.all([DB.all('perfiles', null, 'nombre'), DB.all('roles', null, 'orden'), DB.all('permisos', null, 'orden'), DB.all('rol_permisos')]);
    Object.assign(U, { perfiles, roles, permisos, rp, cargado: true });
    if (puede('usuarios.gestionar')) { try { const r = await DB.fn('usuarios', { accion: 'listar' }); U.auth = {}; (r.usuarios || []).forEach(u => U.auth[u.id] = u); } catch (e) { U.authError = e.message; } }
  }
  const rolN = c => (U.roles.find(r => r.codigo === c) || {}).nombre || ROL_N[c] || c;
  const persona = id => S.personas.find(p => p.id === id);

  async function render() {
    const body = $('usr-body'); if (!body) return;
    if (!enProd()) { body.innerHTML = `<div class="card"><h2>Usuarios y permisos</h2><p class="note">Este módulo funciona con la base de producción y el inicio de sesión activado (<span class="code">produccion: true</span> en <span class="code">js/config.js</span>). En la demo se usa el selector de usuario del menú.</p></div>`; return; }
    if (!U.cargado) { body.innerHTML = '<div class="card"><p class="note">Cargando usuarios…</p></div>'; try { await cargar(); } catch (e) { body.innerHTML = `<div class="card"><p class="note">No se pudieron cargar los usuarios: ${esc(Auth.errorTexto(e))}</p></div>`; return; } }
    document.querySelectorAll('#usr-tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === U.tab));
    if (U.tab === 'usuarios') return renderUsuarios(body);
    if (U.tab === 'roles') return renderRoles(body);
    return renderAccesos(body);
  }

  // ---------------- USUARIOS ----------------
  function renderUsuarios(body) {
    const g = puede('usuarios.gestionar'); const f = U.filtro.toLowerCase();
    const rows = U.perfiles.filter(p => !f || [p.nombre, p.email, rolN(p.rol)].join(' ').toLowerCase().includes(f));
    const act = U.perfiles.filter(p => p.activo).length, pend = U.perfiles.filter(p => !p.activo && p.rol === 'sin_rol').length;
    body.innerHTML = `<div class="grid g4" style="margin-bottom:14px">${[['Usuarios', U.perfiles.length, 'registrados en la plataforma'], ['Activos', act, 'con rol y acceso'], ['Pendientes', pend, 'sin rol asignado'], ['Roles', U.roles.filter(r => r.codigo !== 'sin_rol').length, 'configurables en la matriz']].map(k => `<div class="tile"><div class="l">${k[0]}</div><div class="v" style="font-size:24px">${k[1]}</div><div class="s">${k[2]}</div></div>`).join('')}</div>
    <div class="card"><div class="hd"><div><h2>Usuarios</h2><div class="sub">Cada persona entra con su correo. El rol define qué vistas ve y qué puede modificar; la base de datos lo hace cumplir aunque alguien manipule el navegador.</div></div>
      <div class="row"><input id="usr-q" placeholder="Buscar nombre, correo o rol" value="${esc(U.filtro)}" style="min-width:220px">${g ? '<button class="btn" id="usr-new">Nuevo usuario</button>' : ''}</div></div>
      ${U.authError ? `<div class="alert warn"><span class="dot"></span><div><b>Gestión de cuentas no disponible</b><small>${esc(U.authError)}. Despliega la Edge Function "usuarios" (ver README).</small></div></div>` : ''}
      <div class="tw"><table><thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Persona vinculada</th><th>Estado</th><th>Último acceso</th><th></th></tr></thead><tbody>
      ${rows.map(p => { const a = U.auth[p.id] || {}; const yo = p.id === Auth.perfil.id; return `<tr><td><b>${esc(p.nombre || '—')}</b>${yo ? ' <span class="pill p-info nodot">tú</span>' : ''}</td><td class="mini">${esc(p.email)}${a.confirmado === false ? '<br><span class="pill p-warn nodot">correo sin confirmar</span>' : ''}</td><td>${esc(rolN(p.rol))}</td><td class="mini">${esc((persona(p.persona_id) || {}).nombre || '—')}</td><td>${p.activo ? '<span class="pill p-ok">Activo</span>' : p.rol === 'sin_rol' ? '<span class="pill p-warn">Pendiente</span>' : '<span class="pill p-mut">Inactivo</span>'}${p.debe_cambiar_clave ? '<br><span class="mini">clave temporal</span>' : ''}</td><td class="mini">${fechaH(p.ultimo_acceso || a.ultimo_acceso)}</td>
        <td style="white-space:nowrap">${g ? `<button class="btn sec xs" data-ued="${p.id}">Editar</button> ${yo ? '' : `<button class="btn sec xs" data-ureset="${p.id}">Clave</button> <button class="btn ${p.activo ? 'warn' : ''} xs" data-uest="${p.id}">${p.activo ? 'Desactivar' : 'Activar'}</button>`}` : ''}</td></tr>`; }).join('') || '<tr><td colspan="7" class="note">Sin usuarios</td></tr>'}
      </tbody></table></div></div>`;
    $('usr-q').oninput = e => { U.filtro = e.target.value; const pos = e.target.selectionStart; renderUsuarios(body); const q = $('usr-q'); q.focus(); q.setSelectionRange(pos, pos); };
    if (g) {
      $('usr-new').onclick = () => modalUsuario(null);
      body.querySelectorAll('[data-ued]').forEach(b => b.onclick = () => modalUsuario(U.perfiles.find(p => p.id === b.dataset.ued)));
      body.querySelectorAll('[data-ureset]').forEach(b => b.onclick = () => resetClave(U.perfiles.find(p => p.id === b.dataset.ureset)));
      body.querySelectorAll('[data-uest]').forEach(b => b.onclick = () => cambiarEstado(U.perfiles.find(p => p.id === b.dataset.uest)));
    }
  }
  const opcionesRol = sel => U.roles.filter(r => r.codigo !== 'sin_rol' && (r.codigo !== 'admin' || puede('roles.gestionar') || sel === 'admin')).map(r => `<option value="${r.codigo}" ${r.codigo === sel ? 'selected' : ''}>${esc(r.nombre)}</option>`).join('');
  const opcionesPersona = (sel, propio) => { const usadas = new Set(U.perfiles.filter(p => p.persona_id && p.id !== propio).map(p => p.persona_id)); return `<option value="">— Ninguna —</option>` + S.personas.filter(p => !usadas.has(p.id) || p.id === sel).map(p => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.nombre)} · ${esc(ROL_N[p.rol] || p.rol)}</option>`).join(''); };
  const opcionesBodega = sel => `<option value="">Todas</option>` + (S.bodegas || []).map(b => `<option value="${b.codigo}" ${b.codigo === sel ? 'selected' : ''}>${esc(b.nombre)}</option>`).join('');

  function modalUsuario(p) {
    const nuevo = !p; p = p || { rol: 'planificador' };
    modal(`<h2>${nuevo ? 'Nuevo usuario' : 'Editar usuario'}</h2>
      <div class="stack" style="margin-top:12px">
        ${nuevo ? '<label class="f">Correo (con el que inicia sesión)<input id="u-email" type="email" placeholder="nombre@dgp.com.pa"></label>' : `<div class="note">Correo: <b>${esc(p.email)}</b></div>`}
        <label class="f">Nombre completo<input id="u-nombre" value="${esc(p.nombre || '')}"></label>
        <label class="f">Rol<select id="u-rol">${opcionesRol(p.rol)}</select></label>
        <label class="f">Persona del maestro (obligatorio para conductores: así ve solo sus rutas)<select id="u-persona">${opcionesPersona(p.persona_id, p.id)}</select></label>
        <label class="f">Bodega<select id="u-bodega">${opcionesBodega(p.bodega_codigo)}</select></label>
        ${nuevo ? `<label class="f">Acceso inicial<select id="u-metodo"><option value="temporal">Contraseña temporal (se la entregas tú; la cambia al entrar)</option><option value="invitacion">Invitación por correo (requiere SMTP configurado en Supabase)</option></select></label>` : `<label class="row"><input type="checkbox" id="u-activo" ${p.activo ? 'checked' : ''} ${p.id === Auth.perfil.id ? 'disabled' : ''}> Activo</label>`}
        <div class="note" id="u-msg"></div>
        <div class="row"><button class="btn" id="u-ok">${nuevo ? 'Crear usuario' : 'Guardar'}</button><button class="btn sec" onclick="closeModal()">Cancelar</button></div>
      </div>`);
    $('u-rol').onchange = () => { if ($('u-rol').value === 'conductor' && !$('u-persona').value) $('u-msg').textContent = 'Vincula la persona del conductor: sin eso no verá ninguna ruta.'; };
    $('u-ok').onclick = async () => {
      const datos = { nombre: $('u-nombre').value.trim(), rol: $('u-rol').value, persona_id: $('u-persona').value || null, bodega_codigo: $('u-bodega').value || null };
      if (!datos.nombre) return $('u-msg').textContent = 'Escribe el nombre.';
      if (datos.rol === 'conductor' && !datos.persona_id) return $('u-msg').textContent = 'Un conductor debe estar vinculado a su persona del maestro.';
      try {
        if (nuevo) {
          const email = $('u-email').value.trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return $('u-msg').textContent = 'Correo no válido.';
          const r = await DB.fn('usuarios', Object.assign({ accion: 'crear', email, metodo: $('u-metodo').value }, datos));
          closeModal(); U.cargado = false; await render();
          if (r.clave_temporal) mostrarClave(email, r.clave_temporal); else toast(`Invitación enviada a ${email}`);
        } else {
          datos.activo = $('u-activo').checked;
          if (datos.activo !== p.activo && p.id !== Auth.perfil.id) await DB.fn('usuarios', { accion: 'estado', id: p.id, activo: datos.activo });
          await DB.update('perfiles', { id: p.id }, datos);
          closeModal(); toast('Usuario actualizado'); U.cargado = false; await render();
        }
      } catch (e) { $('u-msg').textContent = Auth.errorTexto(e); }
    };
  }
  function mostrarClave(email, clave) {
    modal(`<h2>Usuario creado</h2><p class="note">Entrega estos datos a la persona por un canal privado. La contraseña solo se muestra ahora; al entrar por primera vez se le pedirá cambiarla.</p>
      <dl class="kv" style="margin:14px 0"><dt>Dirección</dt><dd>${esc(location.origin + location.pathname.replace(/[^/]*$/, ''))}</dd><dt>Correo</dt><dd>${esc(email)}</dd><dt>Contraseña temporal</dt><dd class="code" style="font-size:16px">${esc(clave)}</dd></dl>
      <div class="row"><button class="btn" id="u-copy">Copiar</button><button class="btn sec" onclick="closeModal()">Listo</button></div>`);
    $('u-copy').onclick = () => { navigator.clipboard.writeText(`Torre de Control DGP\n${location.origin}${location.pathname.replace(/[^/]*$/, '')}\nCorreo: ${email}\nContraseña temporal: ${clave}`).then(() => toast('Copiado')); };
  }
  async function resetClave(p) {
    if (!confirm(`¿Generar una contraseña temporal nueva para ${p.nombre || p.email}? La actual deja de funcionar.`)) return;
    try { const r = await DB.fn('usuarios', { accion: 'reset_clave', id: p.id }); U.cargado = false; await render(); mostrarClave(p.email, r.clave_temporal); } catch (e) { toast(Auth.errorTexto(e)); }
  }
  async function cambiarEstado(p) {
    const activar = !p.activo;
    if (activar && p.rol === 'sin_rol') { modalUsuario(p); return toast('Asigna un rol antes de activar'); }
    if (!activar && !confirm(`¿Desactivar a ${p.nombre || p.email}? Pierde el acceso de inmediato.`)) return;
    try { await DB.fn('usuarios', { accion: 'estado', id: p.id, activo: activar }); toast(activar ? 'Usuario activado' : 'Usuario desactivado'); U.cargado = false; await render(); } catch (e) { toast(Auth.errorTexto(e)); }
  }

  // ---------------- ROLES Y PERMISOS ----------------
  function renderRoles(body) {
    const g = puede('roles.gestionar'); const roles = U.roles.filter(r => r.codigo !== 'sin_rol');
    const tiene = (r, p) => U.rp.some(x => x.rol === r && x.permiso === p);
    const mods = [...new Set(U.permisos.map(p => p.modulo))];
    body.innerHTML = `<div class="card"><div class="hd"><div><h2>Matriz de roles y permisos</h2><div class="sub">${g ? 'Marca o desmarca para conceder o quitar un permiso. El cambio aplica en el siguiente inicio de sesión de cada usuario y queda auditado.' : 'Solo lectura: tu rol no gestiona roles.'} Administración tiene siempre todos los permisos.</div></div>${g ? '<button class="btn sec" id="rol-new">Nuevo rol</button>' : ''}</div>
      <div class="perm-grid"><table><thead><tr><th style="text-align:left;left:0;z-index:3">Permiso</th>${roles.map(r => `<th title="${esc(r.descripcion || '')}">${esc(r.nombre)}</th>`).join('')}</tr></thead><tbody>
      ${mods.map(m => `<tr class="mod"><th colspan="${roles.length + 1}">${esc(m)}</th></tr>` + U.permisos.filter(p => p.modulo === m).map(p => `<tr><th title="${esc(p.codigo)}">${esc(p.nombre)}</th>${roles.map(r => `<td><input type="checkbox" aria-label="${esc(r.nombre)}: ${esc(p.nombre)}" data-rp="${r.codigo}|${p.codigo}" ${tiene(r.codigo, p.codigo) ? 'checked' : ''} ${!g || r.codigo === 'admin' ? 'disabled' : ''}></td>`).join('')}</tr>`).join('')).join('')}
      </tbody></table></div></div>`;
    if (!g) return;
    body.querySelectorAll('[data-rp]').forEach(i => i.onchange = async () => {
      const [rol, permiso] = i.dataset.rp.split('|');
      try {
        if (i.checked) { await DB.insert('rol_permisos', { rol, permiso }); U.rp.push({ rol, permiso }); }
        else { await DB.remove('rol_permisos', { rol, permiso }); U.rp = U.rp.filter(x => !(x.rol === rol && x.permiso === permiso)); }
        toast(`${rolN(rol)}: ${i.checked ? 'concedido' : 'retirado'} "${(U.permisos.find(p => p.codigo === permiso) || {}).nombre}"`);
      } catch (e) { i.checked = !i.checked; toast(Auth.errorTexto(e)); }
    });
    $('rol-new').onclick = () => {
      modal(`<h2>Nuevo rol</h2><div class="stack" style="margin-top:12px"><label class="f">Nombre<input id="r-nom" placeholder="Supervisor de despacho"></label><label class="f">Descripción<input id="r-desc"></label><label class="f">Copiar permisos de<select id="r-base"><option value="">— Ninguno —</option>${roles.filter(r => r.codigo !== 'admin').map(r => `<option value="${r.codigo}">${esc(r.nombre)}</option>`).join('')}</select></label><div class="note" id="r-msg"></div><div class="row"><button class="btn" id="r-ok">Crear rol</button><button class="btn sec" onclick="closeModal()">Cancelar</button></div></div>`);
      $('r-ok').onclick = async () => {
        const nombre = $('r-nom').value.trim(); if (!nombre) return $('r-msg').textContent = 'Escribe el nombre.';
        const codigo = nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
        if (U.roles.some(r => r.codigo === codigo)) return $('r-msg').textContent = 'Ya existe un rol con ese nombre.';
        try {
          await DB.insert('roles', { codigo, nombre, descripcion: $('r-desc').value.trim(), orden: 50 });
          const base = $('r-base').value; if (base) { const ps = U.rp.filter(x => x.rol === base).map(x => ({ rol: codigo, permiso: x.permiso })); if (ps.length) await DB.insert('rol_permisos', ps); }
          closeModal(); U.cargado = false; await render(); toast(`Rol "${nombre}" creado`);
        } catch (e) { $('r-msg').textContent = Auth.errorTexto(e); }
      };
    };
  }

  // ---------------- REGISTRO DE SEGURIDAD ----------------
  async function renderAccesos(body) {
    body.innerHTML = '<div class="card"><p class="note">Cargando…</p></div>';
    let au = [];
    try { au = await DB.all('auditoria', { entidad: ['perfiles', 'rol_permisos', 'reglas', 'usuarios', 'roles'] }, 'created_at', { desc: true, limit: 300 }); } catch (e) { body.innerHTML = `<div class="card"><p class="note">${esc(Auth.errorTexto(e))}</p></div>`; return; }
    const resumen = a => { const n = a.valor_nuevo || {}, o = a.valor_anterior || {}; if (a.entidad === 'rol_permisos') return `${a.accion === 'insert' ? 'Concedido' : 'Retirado'} ${n.permiso || o.permiso} a ${rolN(n.rol || o.rol)}`; if (a.entidad === 'perfiles') { const ch = Object.keys(n).filter(k => JSON.stringify(n[k]) !== JSON.stringify(o[k]) && !['ultimo_acceso'].includes(k)); if (a.accion === 'update' && !ch.length) return null; return `${n.email || o.email}: ${a.accion === 'insert' ? 'alta' : ch.map(k => `${k} ${o[k] ?? '—'} → ${n[k] ?? '—'}`).join(', ')}`; } if (a.entidad === 'reglas') return `Regla ${n.clave || o.clave} modificada`; return a.detalle; };
    const filas = au.map(a => ({ a, t: resumen(a) })).filter(x => x.t);
    body.innerHTML = `<div class="grid g2"><div class="card"><div class="hd"><div><h2>Cambios de seguridad</h2><div class="sub">Registrados por la base de datos (no por el navegador): no se pueden editar ni borrar.</div></div></div>
      <div class="tw" style="max-height:60vh;overflow:auto"><table><thead><tr><th>Fecha</th><th>Quién</th><th>Cambio</th></tr></thead><tbody>${filas.map(({ a, t }) => `<tr><td class="code mini">${fechaH(a.created_at)}</td><td class="mini">${esc(a.actor || 'sistema')}</td><td>${esc(t)}</td></tr>`).join('') || '<tr><td colspan="3" class="note">Sin cambios registrados</td></tr>'}</tbody></table></div></div>
      <div class="card"><div class="hd"><div><h2>Últimos accesos</h2><div class="sub">Último inicio de sesión de cada usuario.</div></div></div>
      <div class="tw"><table><thead><tr><th>Usuario</th><th>Rol</th><th>Último acceso</th></tr></thead><tbody>${U.perfiles.slice().sort((x, y) => String(y.ultimo_acceso || '').localeCompare(String(x.ultimo_acceso || ''))).map(p => `<tr><td>${esc(p.nombre || p.email)}</td><td class="mini">${esc(rolN(p.rol))}</td><td class="mini">${fechaH(p.ultimo_acceso)}</td></tr>`).join('')}</tbody></table></div></div></div>`;
  }

  document.addEventListener('DOMContentLoaded', () => { const t = $('usr-tabs'); if (t) t.querySelectorAll('button').forEach(b => b.onclick = () => { U.tab = b.dataset.t; render(); }); });
  return { render, recargar: () => { U.cargado = false; return render(); } };
})();
