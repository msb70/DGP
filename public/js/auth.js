/* DGP · autenticación y permisos (Supabase Auth).
   - Producción (DGP_CONFIG.produccion = true): sin sesión no hay app. Sin modo local.
   - Demo (produccion = false y sin URL): se mantiene el selector de usuarios de la v2.
   Expone window.Auth: init(), perfil, puede(permiso), logout(), cambiarClave(), sb (cliente Supabase). */
window.Auth = (function () {
  const st = { sb: null, session: null, perfil: null, activo: false, recovery: false };
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function cfg() { return Object.assign({}, window.DGP_CONFIG || {}); }
  const prod = () => !!cfg().produccion;

  function overlay(html) {
    let o = document.getElementById('auth-overlay');
    if (!o) { o = document.createElement('div'); o.id = 'auth-overlay'; document.body.appendChild(o); }
    o.innerHTML = `<div class="auth-card"><div class="auth-brand"><div class="logo">DGP</div><div><b>${esc(cfg().titulo || 'Torre de Control')}</b><small>Distribuidora General de Panamá</small></div></div>${html}</div>`;
    o.classList.add('on'); return o;
  }
  function closeOverlay() { const o = document.getElementById('auth-overlay'); if (o) o.classList.remove('on'); }
  const msg = (t, err) => { const e = document.getElementById('auth-msg'); if (e) { e.textContent = t || ''; e.className = 'auth-msg' + (err ? ' err' : ''); } };
  function traducir(e) {
    const m = (e && (e.message || e.error_description || e.msg)) || String(e || '');
    if (/Invalid login credentials/i.test(m)) return 'Correo o contraseña incorrectos.';
    if (/Email not confirmed/i.test(m)) return 'El correo aún no está confirmado. Pide a Administración que lo confirme.';
    if (/banned|User is banned/i.test(m)) return 'Tu usuario está desactivado. Contacta a Administración.';
    if (/rate limit|too many/i.test(m)) return 'Demasiados intentos. Espera unos minutos.';
    if (/Password should be at least|weak/i.test(m)) return 'La contraseña es muy débil: mínimo 10 caracteres, con letras y números.';
    if (/Failed to fetch|NetworkError|network/i.test(m)) return 'Sin conexión con el servidor. Revisa la red.';
    return m;
  }
  const claveValida = p => p && p.length >= 10 && /[A-Za-z]/.test(p) && /\d/.test(p);

  function pantallaLogin(nota) {
    const c = cfg();
    overlay(`<h1>Iniciar sesión</h1>
      ${nota ? `<p class="auth-note">${esc(nota)}</p>` : ''}
      <form id="auth-form" autocomplete="on">
        <label>Correo<input id="auth-email" type="email" autocomplete="username" required></label>
        <label>Contraseña<input id="auth-pass" type="password" autocomplete="current-password" required></label>
        <button class="btn pri" type="submit" id="auth-go">Entrar</button>
      </form>
      ${c.google ? '<button class="btn sec" id="auth-google" type="button">Entrar con Google Workspace</button>' : ''}
      <button class="lnk" id="auth-olvido" type="button">Olvidé mi contraseña</button>
      <div id="auth-msg" class="auth-msg"></div>`);
    document.getElementById('auth-form').onsubmit = async ev => {
      ev.preventDefault(); const b = document.getElementById('auth-go'); b.disabled = true; msg('Verificando…');
      const { error } = await st.sb.auth.signInWithPassword({ email: document.getElementById('auth-email').value.trim(), password: document.getElementById('auth-pass').value });
      b.disabled = false; if (error) return msg(traducir(error), true);
      location.reload();
    };
    const g = document.getElementById('auth-google');
    if (g) g.onclick = () => st.sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.href.split('#')[0], queryParams: c.google_hd ? { hd: c.google_hd } : {} } });
    document.getElementById('auth-olvido').onclick = async () => {
      const email = document.getElementById('auth-email').value.trim(); if (!email) return msg('Escribe tu correo y vuelve a pulsar.', true);
      const { error } = await st.sb.auth.resetPasswordForEmail(email, { redirectTo: location.href.split('#')[0] });
      msg(error ? traducir(error) : 'Si el correo existe, recibirás un enlace para crear una nueva contraseña.', !!error);
    };
    setTimeout(() => { const e = document.getElementById('auth-email'); if (e) e.focus(); }, 30);
  }

  function pantallaNuevaClave(titulo, nota) {
    return new Promise(resolve => {
      overlay(`<h1>${esc(titulo)}</h1><p class="auth-note">${esc(nota)}</p>
        <form id="auth-form"><label>Nueva contraseña<input id="auth-p1" type="password" autocomplete="new-password" required></label>
        <label>Repetir contraseña<input id="auth-p2" type="password" autocomplete="new-password" required></label>
        <button class="btn pri" type="submit">Guardar contraseña</button></form><div id="auth-msg" class="auth-msg"></div>`);
      document.getElementById('auth-form').onsubmit = async ev => {
        ev.preventDefault(); const a = document.getElementById('auth-p1').value, b = document.getElementById('auth-p2').value;
        if (a !== b) return msg('Las contraseñas no coinciden.', true);
        if (!claveValida(a)) return msg('Mínimo 10 caracteres, con letras y números.', true);
        const { error } = await st.sb.auth.updateUser({ password: a });
        if (error) return msg(traducir(error), true);
        try { await st.sb.rpc('clave_cambiada'); } catch (e) { }
        resolve(true);
      };
    });
  }

  function pantallaBloqueo(titulo, texto) {
    overlay(`<h1>${esc(titulo)}</h1><p class="auth-note">${esc(texto)}</p><button class="btn" id="auth-out">Cerrar sesión</button>`);
    document.getElementById('auth-out').onclick = logout;
  }

  async function init(opts = {}) {
    const c = cfg();
    if (!c.url || !c.key || !window.supabase) {
      if (prod()) { pantallaBloqueo('Configuración incompleta', 'Falta la URL o la clave pública de Supabase en js/config.js. La aplicación no arranca sin base de datos en producción.'); throw new Error('sin_config'); }
      return null; // demo local
    }
    st.sb = window.supabase.createClient(c.url, c.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'dgp-auth' } });
    if (!prod()) return null; // demo con Supabase pero sin login
    st.sb.auth.onAuthStateChange((ev) => { if (ev === 'PASSWORD_RECOVERY') st.recovery = true; if (ev === 'SIGNED_OUT' && st.activo) location.reload(); });
    const isRecovery = /type=recovery/.test(location.hash);
    const { data } = await st.sb.auth.getSession(); st.session = data.session;
    if (!st.session) { pantallaLogin(opts.nota); throw new Error('sin_sesion'); }
    if (isRecovery || st.recovery) { await pantallaNuevaClave('Nueva contraseña', 'Escribe tu nueva contraseña.'); history.replaceState(null, '', location.pathname + location.search); }
    let perfil = null;
    try { const r = await st.sb.rpc('mi_perfil'); if (r.error) throw r.error; perfil = r.data; }
    catch (e) { pantallaBloqueo('No se pudo cargar tu perfil', traducir(e)); throw e; }
    if (!perfil || !perfil.activo || perfil.rol === 'sin_rol') { pantallaBloqueo('Usuario pendiente de activación', `Tu cuenta (${st.session.user.email}) existe pero aún no tiene un rol activo. Pide a Administración que te asigne un rol.`); throw new Error('inactivo'); }
    if ((opts.requiere && !perfil.permisos.includes(opts.requiere)) || (opts.valida && !opts.valida(perfil))) { pantallaBloqueo('Sin acceso a esta aplicación', opts.textoSinAcceso || 'Tu rol no tiene acceso a esta aplicación.'); throw new Error('sin_permiso'); }
    if (perfil.debe_cambiar_clave) await pantallaNuevaClave('Cambia tu contraseña', 'Es tu primer acceso: reemplaza la contraseña temporal que te dieron.');
    st.perfil = perfil; st.activo = true; closeOverlay();
    st.sb.rpc('registrar_acceso').then(() => { }, () => { });
    return perfil;
  }
  async function logout() { try { await st.sb.auth.signOut(); } catch (e) { } try { localStorage.removeItem('dgp-auth'); } catch (e) { } location.reload(); }
  async function cambiarClave() { await pantallaNuevaClave('Cambiar contraseña', 'Mínimo 10 caracteres, con letras y números.'); closeOverlay(); }
  const puede = p => !!(st.perfil && st.perfil.permisos && st.perfil.permisos.includes(p));
  async function token() { if (!st.sb) return null; const { data } = await st.sb.auth.getSession(); return data.session ? data.session.access_token : null; }
  /* Errores de la base en lenguaje de negocio. Ningún error de guardado queda en silencio. */
  function errorTexto(e) {
    const code = e && e.code, m = (e && (e.message || e.details)) || String(e || '');
    if (code === '42501' || /row-level security|permission denied|violates row-level/i.test(m)) return 'No tienes permiso para esta acción.';
    if (code === '23505' || /duplicate key/i.test(m)) return 'Ese registro ya existe (duplicado).';
    if (code === '23503') return 'El registro está relacionado con otros datos y no se puede cambiar así.';
    if (code === 'PGRST301' || /JWT expired|invalid JWT/i.test(m)) return 'Tu sesión expiró. Vuelve a iniciar sesión.';
    return traducir(e);
  }
  window.addEventListener('unhandledrejection', ev => {
    const t = errorTexto(ev.reason); console.error('[DGP]', ev.reason);
    try { if (typeof toast === 'function') toast('No se guardó: ' + t); } catch (x) { }
    if (/sesión expiró/.test(t) && st.activo) setTimeout(() => location.reload(), 2500);
  });
  return {
    errorTexto, init, logout, cambiarClave, puede, token, prod, claveValida, traducir,
    get sb() { return st.sb; }, get perfil() { return st.perfil; }, get activo() { return st.activo; }, get user() { return st.session && st.session.user; }
  };
})();
