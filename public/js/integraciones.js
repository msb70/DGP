/* DGP · Integraciones (v3): WhatsApp Business (Cloud API) y Zoho Inventory + Books (o solo Books).
   Las credenciales se pegan aquí una vez y las guarda la Edge Function en el esquema privado: el navegador nunca las vuelve a ver.
   Aquí se ve el estado, se activa el envío real, se prueban las conexiones y se lanzan las sincronizaciones. */
window.INTEG = (function () {
  const I = { integ: [], plantillas: [], cola: [], log: [], entrantes: [], wa: null, zoho: null, metaPl: null, cargado: false };
  const g = () => puede('integraciones.gestionar');
  const fechaH = t => t ? new Date(t).toLocaleString('es-PA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  const row = s => I.integ.find(i => i.sistema === s) || {};
  const pillEstado = (e, txt) => `<span class="estado-pill ${e === 'conectado' ? 'ok' : e === 'error' ? 'crit' : 'warn'}"><i></i>${esc(txt || { conectado: 'Conectado', error: 'Con error', sin_configurar: 'Sin configurar' }[e] || e || '—')}</span>`;
  // Conexión con Zoho: el administrador de DGP genera el código del Self Client y lo pega aquí; la función lo canjea al instante.
  const alerta = (tipo, titulo, txt) => `<div class="alert ${tipo}"><span class="dot"></span><div><b>${titulo}</b><small>${txt}</small></div></div>`;
  const conectarHtml = abierto => !g() ? '' : `<details id="zo-con" ${(I.zoAbierto ?? abierto) ? 'open' : ''}><summary class="mini"><b>${abierto ? 'Conectar con Zoho' : 'Reconectar o cambiar de cuenta de Zoho'}</b></summary><div class="stack" style="margin-top:8px">
    <ol class="mini" style="margin:0 0 0 18px;padding:0"><li>Un administrador de Zoho de DGP entra en <b>api-console.zoho.com → Self Client → Generate Code</b>.</li>
      <li>Scope: <span class="code">ZohoBooks.fullaccess.all,ZohoInventory.fullaccess.all</span> · duración: 10 minutos · elige la organización de DGP.</li>
      <li>Pega aquí el código (o el contenido completo de <span class="code">self_client.json</span>) antes de que caduque. Se usa una sola vez.</li></ol>
    <label class="f">Código de Zoho o contenido de self_client.json<textarea id="zo-oauth" rows="2" placeholder="1000.xxxxxxxx.yyyyyyyy" autocomplete="off" spellcheck="false">${esc(I.zoDraft || '')}</textarea></label>
    <div class="row"><button class="btn sm" id="zo-conectar">Conectar</button><span class="mini" id="zo-con-msg"></span></div></div></details>`;
  function zohoEstado(zo) {
    if (zo.fallo) return alerta('warn', 'Edge Function "zoho" no responde', esc(zo.fallo));
    if (!zo.faltan) return '<p class="note">Comprobando conexión…</p>';
    const avisos = (I.zoAvisos || []).length ? alerta('warn', 'Conectado con avisos', I.zoAvisos.map(esc).join('<br>')) : '';
    if (!zo.cliente) return alerta('warn', 'Falta el Self Client', 'Carga ZOHO_CLIENT_ID y ZOHO_CLIENT_SECRET en Supabase → Edge Functions → Secrets (del Self Client de la cuenta de Zoho de DGP).');
    if (!zo.conectado) return alerta('warn', 'Zoho sin conectar', 'El Self Client está cargado. Falta pegar el código que genera DGP.') + conectarHtml(true);
    if (zo.error) return alerta('crit', 'Zoho rechazó la conexión', esc(zo.error)) + conectarHtml(true);
    const orgs = zo.organizaciones || zo.organizaciones_guardadas || [];
    if (!zo.org) return avisos + alerta('warn', 'Elige la organización', 'La cuenta conectada ve varias organizaciones de Zoho.') + (g() ? `<div class="row"><select id="zo-org">${orgs.map(o => `<option value="${esc(o.id)}">${esc(o.nombre)} (${esc(o.id)})</option>`).join('')}</select><button class="btn sm" id="zo-org-ok">Usar esta</button></div>` : '') + conectarHtml(false);
    if (!zo.ok) return '<p class="note">Comprobando conexión…</p>';
    const sel = orgs.find(o => String(o.id) === String(zo.org));
    return avisos + `<dl class="kv"><dt>Organización</dt><dd>${sel ? `${esc(sel.nombre)} (${esc(sel.id)}, ${esc(sel.moneda || '')})` : esc(zo.org)}</dd><dt>Centro de datos</dt><dd>zoho.${esc(zo.dc)}</dd><dt>Conexión</dt><dd>${zo.origen === 'plataforma' ? `por ${esc(zo.conectado_por || '—')} · ${fechaH(zo.conectado_at)}` : 'secretos de la función'}</dd></dl>` + conectarHtml(false);
  }
  // Conexión con WhatsApp: DGP pega el token permanente del usuario del sistema y la clave secreta de la app de Meta.
  const waConectarHtml = abierto => !g() ? '' : `<details id="wa-con" ${(I.waAbierto ?? abierto) ? 'open' : ''}><summary class="mini"><b>${abierto ? 'Conectar con WhatsApp' : 'Reconectar o cambiar de número'}</b></summary><div class="stack" style="margin-top:8px">
    <ol class="mini" style="margin:0 0 0 18px;padding:0"><li>En <b>business.facebook.com → Configuración del negocio → Usuarios del sistema</b>, un administrador de DGP crea (o abre) un usuario del sistema con rol <b>Administrador</b>.</li>
      <li><b>Asignar activos</b>: la app de Meta y la cuenta de WhatsApp de DGP, con control total.</li>
      <li><b>Generar token</b>: elige la app, caducidad <b>Nunca</b> y marca <span class="code">whatsapp_business_messaging</span> y <span class="code">whatsapp_business_management</span>. Cópialo: Meta solo lo muestra una vez.</li>
      <li>Clave secreta de la app: <b>developers.facebook.com → la app → Configuración → Básica → Clave secreta de la app → Mostrar</b>.</li>
      <li>Pega los dos aquí. El número, la cuenta y el webhook se configuran solos.</li></ol>
    <label class="f">Token del usuario del sistema<textarea id="wa-token" rows="3" placeholder="EAA…" autocomplete="off" spellcheck="false">${esc(I.waDraft || '')}</textarea></label>
    <label class="f">Clave secreta de la app (32 caracteres)<input id="wa-secret" type="password" autocomplete="off" spellcheck="false" placeholder="••••••••••••••••••••••••••••••••" value="${esc(I.waSec || '')}"></label>
    <div class="row"><button class="btn sm" id="wa-conectar">Conectar</button><span class="mini" id="wa-con-msg"></span></div></div></details>`;
  const waManual = wa => `<div class="mini">Registro manual del webhook (Meta for Developers → la app → WhatsApp → Configuración): URL <span class="code">${esc(wa.webhook || '')}</span>${wa.verify_token ? ` · token de verificación <span class="code">${esc(wa.verify_token)}</span>` : ''} · campo <span class="code">messages</span>.</div>`;
  function waEstado(wa) {
    if (wa.fallo) return alerta('warn', 'Edge Function "whatsapp" no responde', esc(wa.fallo));
    if (!('conectado' in wa)) return '<p class="note">Comprobando conexión…</p>';
    const avisos = (I.waAvisos || []).length ? alerta('warn', 'Conectado con avisos', I.waAvisos.map(esc).join('<br>')) : '';
    if (!wa.migracion && wa.origen !== 'secretos') return alerta('warn', 'Falta preparar la base', 'Ejecuta supabase/migraciones/2026-10-10_whatsapp_10d.sql en el SQL Editor de Supabase.');
    if (wa.falta_numero) return avisos + alerta('warn', 'Elige el número', 'La cuenta conectada tiene varios números de WhatsApp.') + (g() ? `<div class="row"><select id="wa-num">${(wa.numeros || []).map(n => `<option value="${esc(n.id)}">${esc(n.numero)} · ${esc(n.nombre || '')}</option>`).join('')}</select><button class="btn sm" id="wa-num-ok">Usar este</button></div>` : '') + waConectarHtml(false);
    if (!wa.conectado) return alerta('warn', 'WhatsApp sin conectar', 'Falta pegar el token y la clave secreta que entrega DGP.') + waConectarHtml(true);
    if (wa.error) return alerta('crit', 'Meta rechazó la conexión', esc(wa.error)) + waConectarHtml(true);
    if (!wa.numero) return '<p class="note">Comprobando conexión…</p>';
    const inf = wa.infra || {};
    const envio = inf.pg_net && inf.barrido ? 'inmediato y barrido cada 5 min' : inf.pg_net ? 'inmediato (sin barrido programado: usa «Procesar pendientes»)' : 'manual con «Procesar pendientes» (activa pg_net y pg_cron)';
    return avisos + (wa.token_expira ? alerta('warn', 'Token temporal', `Caduca el ${esc(String(wa.token_expira).slice(0, 10))}. Genera uno con caducidad «Nunca» y reconecta.`) : '')
      + `<dl class="kv"><dt>Número</dt><dd>${esc(wa.numero.display_phone_number)} · ${esc(wa.numero.verified_name || '')}</dd><dt>Calidad</dt><dd>${esc(wa.numero.quality_rating || '—')}</dd>
        <dt>Conexión</dt><dd>${wa.origen === 'plataforma' ? `por ${esc(wa.conectado_por || '—')} · ${fechaH(wa.conectado_at)}` : 'secretos de la función'}</dd>
        <dt>Webhook</dt><dd>${wa.webhook_ok === false ? '⚠️ sin registrar' : wa.webhook_ok ? 'registrado' : '—'}</dd><dt>Envío</dt><dd>${esc(envio)}</dd></dl>`
      + (wa.webhook_ok === false && g() ? waManual(wa) : '') + waConectarHtml(false);
  }
  const check = (ok, t) => `<li>${ok ? '✅' : '⬜'} <span class="code">${t}</span></li>`;

  async function cargar() {
    const hace = new Date(Date.now() - 2 * 864e5).toISOString();
    const [integ, plantillas, cola, log, entrantes] = await Promise.all([DB.all('integraciones'), DB.all('wa_plantillas'), DB.all('notificaciones', null, 'created_at', { desc: true, limit: 400, gte: { created_at: hace }, or: 'canal.like.whatsapp*,canal.eq.prueba' }), DB.all('sync_log', null, 'inicio', { desc: true, limit: 30 }), DB.all('wa_entrantes', null, 'created_at', { desc: true, limit: 50 })]);
    Object.assign(I, { integ, plantillas, cola, log, entrantes, cargado: true });
    S.integraciones = integ;
    const err = cola.filter(n => ['error', 'fallido', 'sin_telefono', 'sin_plantilla'].includes(n.estado)).length;
    const b = $('n-integ'); if (b) { b.hidden = !err; b.textContent = err; b.className = 'n' + (err ? ' hot' : ''); }
  }
  async function diagnosticar() {
    const [wa, zoho] = await Promise.all([DB.fn('whatsapp', { accion: 'estado' }).catch(e => ({ fallo: e.message })), DB.fn('zoho', { accion: 'estado' }).catch(e => ({ fallo: e.message }))]);
    I.wa = wa; I.zoho = zoho; I.integ = await DB.all('integraciones'); render();
  }

  async function render() {
    const body = $('integ-body'); if (!body) return;
    if (DB.getMode() !== 'supabase') { body.innerHTML = '<div class="card"><h2>Integraciones</h2><p class="note">Requiere la base de Supabase de producción.</p></div>'; return; }
    if (!I.cargado) { body.innerHTML = '<div class="card"><p class="note">Cargando integraciones…</p></div>'; try { await cargar(); } catch (e) { body.innerHTML = `<div class="card"><p class="note">No se pudieron cargar las integraciones: ${esc(Auth.errorTexto(e))}. ¿Se ejecutó supabase/v3_produccion.sql?</p></div>`; return; } if (!I.wa) diagnosticar(); }
    const W = row('whatsapp'), ZI = row('zoho_inventory'), ZB = row('zoho_books');
    const cnt = e => I.cola.filter(n => n.estado === e).length;
    const wa = I.wa || {};
    const zo = I.zoho || {}; const soloBooks = zo.producto === 'books'; const ZA = row(soloBooks ? 'zoho_books' : 'zoho_inventory');
    body.innerHTML = `<div class="integ-grid">
    <div class="card"><div class="hd"><div><h2>WhatsApp Business</h2><div class="sub">Avisos a clientes al salir la ruta y por demoras, con plantillas aprobadas por Meta.</div></div>${pillEstado(W.estado)}</div>
      <div class="stack">
        <label class="row"><input type="checkbox" id="wa-activo" ${W.activo ? 'checked' : ''} ${g() ? '' : 'disabled'}> <b>Envío real activado</b> <span class="note">Apagado: los avisos quedan como "simulado".</span></label>
        ${waEstado(wa)}
        <div class="grid g4">${[['Pendientes', cnt('pendiente') + cnt('enviando')], ['Enviados', cnt('enviado') + cnt('entregado') + cnt('leido')], ['Leídos', cnt('leido')], ['Con problema', cnt('error') + cnt('fallido') + cnt('sin_telefono') + cnt('sin_plantilla')]].map(k => `<div class="tile"><div class="l">${k[0]}</div><div class="v" style="font-size:20px">${k[1]}</div><div class="s">últimas 48 h</div></div>`).join('')}</div>
        ${g() ? `<div class="row"><button class="btn sm" id="wa-diag">Probar conexión</button><button class="btn sm sec" id="wa-proc">Procesar pendientes</button><button class="btn sm sec" id="wa-test">Mensaje de prueba</button></div>` : ''}
      </div></div>
    <div class="card"><div class="hd"><div><h2>${soloBooks ? 'Zoho Books' : 'Zoho Inventory · Books'}</h2><div class="sub">Clientes, artículos y órdenes de venta entran desde Zoho; ${soloBooks ? 'el despacho verificado (paso 7) queda como comentario en la orden de venta, con las diferencias.' : 'el despacho verificado (paso 7) crea el paquete con las cantidades verificadas y el envío en Inventory.'}</div></div>${pillEstado(ZI.estado === 'conectado' || ZB.estado === 'conectado' ? 'conectado' : ZI.estado === 'error' || ZB.estado === 'error' ? 'error' : 'sin_configurar')}</div>
      <div class="stack">
        ${zohoEstado(zo)}
        <label class="row"><input type="checkbox" id="zo-activo" ${ZA.activo ? 'checked' : ''} ${g() ? '' : 'disabled'}> <b>Registrar despachos reales en ${soloBooks ? 'Zoho Books' : 'Zoho Inventory'}</b> <span class="note">Apagado: el paso 7 queda simulado.</span></label>
        ${g() ? `<div class="row"><label class="mini">Cambios desde <input type="date" id="zo-desde"></label><button class="btn sm" data-sync="sync_clientes">Sincronizar clientes</button><button class="btn sm" data-sync="sync_articulos">Artículos</button><button class="btn sm" data-sync="sync_pedidos">Órdenes de venta</button><button class="btn sm sec" id="zo-diag">Probar</button></div>
        <details><summary class="mini"><b>Mapeo de campos</b></summary><div class="stack" style="margin-top:8px">
          <label class="f">Código de cliente<select id="zo-codigo"><option value="contact_number">Número de contacto de Zoho</option><option value="contact_id">ID de Zoho</option></select></label>
          <label class="f">Las cantidades de Zoho están en<select id="zo-unidad"><option value="caja">Cajas</option><option value="unidad">Unidades (se convierten con unidades por caja)</option></select></label>
          <label class="f">Campo personalizado del ejecutivo de cuenta (api_name)<input id="zo-ejec" placeholder="cf_ejecutivo"></label>
          <label class="f" ${soloBooks ? '' : 'style="display:none"'}>Órdenes de venta a traer (solo Books)<select id="zo-filtro"><option value="Status.Open">Abiertas (sin facturar)</option><option value="Status.Open,Status.PartiallyInvoiced,Status.Invoiced">Abiertas y facturadas (si facturan antes de despachar)</option></select></label>
          <label class="f">Antigüedad máxima de la orden (días)<input id="zo-dias" type="number" min="1" max="365" placeholder="30"></label>
          <label class="f" ${soloBooks ? '' : 'style="display:none"'}>ID del campo personalizado «Estado de despacho» en la orden (opcional, solo Books)<input id="zo-cfdesp" placeholder="customfield_id, p. ej. 4600000001234"></label>
          <button class="btn sm sec" id="zo-map">Guardar mapeo</button></div></details>` : ''}
      </div></div>
    </div>
    <div class="grid g2" style="margin-top:14px">
    <div class="card"><div class="hd"><div><h2>Plantillas de WhatsApp</h2><div class="sub">Deben existir y estar aprobadas con el mismo nombre e idioma en WhatsApp Manager. Variables en orden {{1}}, {{2}}, {{3}}.</div></div>${g() ? '<button class="btn sm sec" id="wa-meta">Comparar con Meta</button>' : ''}</div>
      <div class="tw"><table><thead><tr><th>Uso</th><th>Nombre en Meta</th><th>Texto</th><th>Estado</th></tr></thead><tbody>${I.plantillas.map(p => { const m = (I.metaPl || []).find(x => x.name === p.nombre_meta && (x.language || '').startsWith(p.idioma)); return `<tr><td><b>${esc(p.codigo)}</b><br><span class="mini">${esc((p.motivos || []).join(', '))}</span></td><td class="code mini">${esc(p.nombre_meta)} · ${esc(p.idioma)}</td><td class="mini">${esc(p.cuerpo)}</td><td>${!p.activa ? '<span class="pill p-mut">Inactiva</span>' : I.metaPl ? (m ? `<span class="pill ${m.status === 'APPROVED' ? 'p-ok' : 'p-warn'}">${esc(m.status)}</span>` : '<span class="pill p-crit">No existe en Meta</span>') : '<span class="pill p-mut nodot">sin comparar</span>'}</td></tr>`; }).join('')}</tbody></table></div></div>
    <div class="card"><div class="hd"><div><h2>Avisos con problema</h2><div class="sub">Últimas 48 horas. Corrige el teléfono del cliente en el catálogo o la plantilla y reintenta.</div></div></div>
      <div class="tw" style="max-height:340px;overflow:auto"><table><thead><tr><th>Hora</th><th>Destinatario</th><th>Estado</th><th>Detalle</th><th></th></tr></thead><tbody>${I.cola.filter(n => ['error', 'fallido', 'sin_telefono', 'sin_plantilla'].includes(n.estado)).slice(0, 80).map(n => `<tr><td class="code mini">${fechaH(n.created_at)}</td><td class="mini"><b>${esc(n.destinatario)}</b><br>${esc(n.telefono || 'sin teléfono')}</td><td><span class="pill p-crit nodot">${esc(n.estado)}</span></td><td class="mini">${esc(n.error || '')}</td><td>${puede('notificaciones.enviar') && n.telefono ? `<button class="btn xs sec" data-retry="${n.id}">Reintentar</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="note">Sin problemas</td></tr>'}</tbody></table></div></div>
    <div class="card"><div class="hd"><div><h2>Sincronizaciones</h2><div class="sub">Registro de cada ejecución con Zoho.</div></div></div>
      <div class="tw" style="max-height:340px;overflow:auto"><table><thead><tr><th>Inicio</th><th>Entidad</th><th>Resultado</th><th>Quién</th></tr></thead><tbody>${I.log.map(l => `<tr><td class="code mini">${fechaH(l.inicio)}</td><td>${esc(l.entidad)} <span class="mini">${esc(l.direccion)}</span></td><td><span class="pill ${l.estado === 'ok' ? 'p-ok' : l.estado === 'parcial' ? 'p-warn' : l.estado === 'error' ? 'p-crit' : 'p-info'} nodot">${esc(l.estado)}</span> <span class="mini">${esc(l.mensaje || '')}</span></td><td class="mini">${esc(l.actor || '')}</td></tr>`).join('') || '<tr><td colspan="4" class="note">Sin ejecuciones</td></tr>'}</tbody></table></div></div>
    <div class="card"><div class="hd"><div><h2>Respuestas de clientes por WhatsApp</h2><div class="sub">Mensajes recibidos en el número de empresa (webhook).</div></div></div>
      <div class="tw" style="max-height:340px;overflow:auto"><table><thead><tr><th>Hora</th><th>De</th><th>Mensaje</th></tr></thead><tbody>${I.entrantes.map(m => { const c = S.clientes.find(x => x.id === m.cliente_id); return `<tr><td class="code mini">${fechaH(m.created_at)}</td><td class="mini"><b>${esc(c ? c.nombre : (m.nombre || ''))}</b><br>${esc(m.telefono)}</td><td>${esc(m.texto || '[' + (m.tipo || '') + ']')}</td></tr>`; }).join('') || '<tr><td colspan="3" class="note">Sin mensajes</td></tr>'}</tbody></table></div></div>
    </div>`;
    wire();
  }

  function wire() {
    const on = (id, f) => { const e = $(id); if (e) e.onclick = f; };
    const cfgZ = Object.assign({}, row('zoho_inventory').config || {}, row('zoho_books').config || {});
    if ($('zo-codigo')) { $('zo-codigo').value = cfgZ.codigo_cliente || 'contact_number'; $('zo-unidad').value = cfgZ.unidad_zoho || 'caja'; $('zo-ejec').value = cfgZ.campo_ejecutivo || '';
      $('zo-filtro').value = (cfgZ.filtros_pedidos || ['Status.Open']).join(',') === 'Status.Open' ? 'Status.Open' : 'Status.Open,Status.PartiallyInvoiced,Status.Invoiced'; $('zo-dias').value = cfgZ.dias_pedidos || ''; $('zo-cfdesp').value = cfgZ.campo_despacho_id || ''; }
    const toggle = (id, sistema, txt) => { const e = $(id); if (!e) return; e.onchange = async () => { try { await DB.update('integraciones', { sistema }, { activo: e.checked, updated_at: new Date().toISOString() }); await DB.audit('integraciones', e.checked ? 'activada' : 'desactivada', `${txt} ${e.checked ? 'activado' : 'desactivado'}`, ACTOR, false, sistema); toast(`${txt}: ${e.checked ? 'activado' : 'desactivado'}`); I.cargado = false; render(); } catch (x) { e.checked = !e.checked; toast(Auth.errorTexto(x)); } }; };
    toggle('wa-activo', 'whatsapp', 'Envío real de WhatsApp'); toggle('zo-activo', (I.zoho || {}).producto === 'books' ? 'zoho_books' : 'zoho_inventory', 'Registro de despachos en Zoho');
    on('wa-diag', () => { I.wa = null; render(); diagnosticar(); }); on('zo-diag', () => { I.zoho = null; render(); diagnosticar(); });
    on('wa-proc', async () => { try { const r = await DB.fn('whatsapp', { accion: 'procesar' }); toast(r.error ? r.error : `${r.enviados || 0} enviados · ${r.errores || 0} con error`); I.cargado = false; render(); } catch (e) { toast(e.message); } });
    on('wa-test', () => {
      modal(`<h2>Mensaje de prueba</h2><div class="stack" style="margin-top:12px"><label class="f">Teléfono (Panamá: 8 dígitos)<input id="t-tel" placeholder="6123-4567"></label>
        <label class="f">Plantilla<select id="t-pl"><option value="">Texto libre (solo llega si ese número escribió en las últimas 24 h)</option>${I.plantillas.filter(p => p.activa).map(p => `<option value="${p.codigo}">${esc(p.nombre_meta)}</option>`).join('')}</select></label>
        <label class="f">Variables separadas por | <input id="t-par" placeholder="FAC-0001 | 07:45 | 09:30"></label>
        <div class="note" id="t-msg"></div><div class="row"><button class="btn" id="t-ok">Enviar</button><button class="btn sec" onclick="closeModal()">Cerrar</button></div></div>`);
      $('t-ok').onclick = async () => { $('t-msg').textContent = 'Enviando…'; try { const r = await DB.fn('whatsapp', { accion: 'prueba', telefono: $('t-tel').value, plantilla: $('t-pl').value || null, parametros: $('t-par').value ? $('t-par').value.split('|').map(x => x.trim()) : [] }); $('t-msg').textContent = r.ok ? `Enviado (id ${r.id}). Revisa el teléfono.` : r.error; } catch (e) { $('t-msg').textContent = e.message; } };
    });
    on('wa-meta', async () => { try { const r = await DB.fn('whatsapp', { accion: 'plantillas_meta' }); I.metaPl = r.plantillas || []; render(); } catch (e) { toast(e.message); } });
    document.querySelectorAll('[data-retry]').forEach(b => b.onclick = async () => { try { await DB.update('notificaciones', { id: b.dataset.retry }, { estado: 'pendiente', intentos: 0, error: null }); const r = await DB.fn('whatsapp', { accion: 'procesar', ids: [b.dataset.retry] }); toast(r.enviados ? 'Reenviado' : 'Sigue con error: revisa el detalle'); I.cargado = false; render(); } catch (e) { toast(Auth.errorTexto(e)); } });
    document.querySelectorAll('[data-sync]').forEach(b => b.onclick = async () => {
      const desde = $('zo-desde').value || undefined;
      try { const r = await DB.fn('zoho', { accion: b.dataset.sync, desde }); toast(`${b.textContent}: ${r.leidos} leídos · ${r.creados} nuevos · ${r.actualizados} actualizados${r.errores ? ' · ' + r.errores + ' con error' : ''}`); }
      catch (e) { toast(e.message); }
      I.cargado = false; await render(); if (typeof loadAll === 'function') { await loadAll(); }
    });
    if ($('wa-token')) $('wa-token').oninput = e => { I.waDraft = e.target.value; };
    if ($('wa-secret')) $('wa-secret').oninput = e => { I.waSec = e.target.value; };
    if ($('wa-con')) $('wa-con').ontoggle = e => { I.waAbierto = e.target.open; };
    on('wa-conectar', async () => {
      const t = ($('wa-token').value || '').trim(), k = ($('wa-secret').value || '').trim(), m = $('wa-con-msg'), b = $('wa-conectar');
      if (!t || !k) { m.textContent = 'Pega el token y la clave secreta.'; return; }
      b.disabled = true; m.textContent = 'Conectando con Meta…';
      try { const r = await DB.fn('whatsapp', { accion: 'conectar', token: t, app_secret: k }); I.waAvisos = r.avisos || []; I.waDraft = ''; I.waSec = ''; I.waAbierto = undefined; toast(r.numero ? `WhatsApp conectado: ${r.numero.numero}` : 'WhatsApp conectado: elige el número'); I.wa = null; I.cargado = false; await render(); diagnosticar(); }
      catch (e) { m.textContent = e.message; b.disabled = false; }
    });
    on('wa-num-ok', async () => { try { await DB.fn('whatsapp', { accion: 'elegir_numero', phone_number_id: $('wa-num').value }); toast('Número guardado'); I.wa = null; I.cargado = false; await render(); diagnosticar(); } catch (e) { toast(e.message); } });
    // El código caduca en minutos: lo pegado y el panel abierto sobreviven a los refrescos de la pantalla
    if ($('zo-oauth')) $('zo-oauth').oninput = e => { I.zoDraft = e.target.value; };
    if ($('zo-con')) $('zo-con').ontoggle = e => { I.zoAbierto = e.target.open; };
    on('zo-conectar', async () => {
      const v = ($('zo-oauth').value || '').trim(), m = $('zo-con-msg'), b = $('zo-conectar'); if (!v) { m.textContent = 'Pega el código primero.'; return; }
      b.disabled = true; m.textContent = 'Conectando con Zoho…';
      try { const r = await DB.fn('zoho', { accion: 'conectar', codigo: v }); I.zoAvisos = r.avisos || []; I.zoDraft = ''; I.zoAbierto = undefined; toast(r.org ? 'Zoho conectado' : 'Zoho conectado: elige la organización'); I.zoho = null; I.cargado = false; await render(); diagnosticar(); }
      catch (e) { I.zoDraft = ''; m.textContent = e.message; b.disabled = false; if ($('zo-oauth')) $('zo-oauth').value = ''; }
    });
    on('zo-org-ok', async () => { try { await DB.fn('zoho', { accion: 'elegir_org', org_id: $('zo-org').value }); toast('Organización guardada'); I.zoho = null; I.cargado = false; await render(); diagnosticar(); } catch (e) { toast(e.message); } });
    on('zo-map', async () => { const c = Object.assign({}, cfgZ, { codigo_cliente: $('zo-codigo').value, unidad_zoho: $('zo-unidad').value, campo_ejecutivo: $('zo-ejec').value.trim() || null, filtros_pedidos: $('zo-filtro').value.split(','), dias_pedidos: Number($('zo-dias').value) || 30, campo_despacho_id: $('zo-cfdesp').value.replace(/\D/g, '') || null }); try { await DB.update('integraciones', { sistema: ['zoho_inventory', 'zoho_books'] }, { config: c }); toast('Mapeo guardado'); I.cargado = false; render(); } catch (e) { toast(Auth.errorTexto(e)); } });
  }
  return { render, recargar: () => { I.cargado = false; return render(); } };
})();
