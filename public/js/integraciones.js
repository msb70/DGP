/* DGP · Integraciones (v3): WhatsApp Business (Cloud API) y Zoho Books / Inventory.
   Los secretos viven en las Edge Functions (Supabase → Edge Functions → Secrets), nunca en el navegador.
   Aquí se ve el estado, se activa el envío real, se prueban las conexiones y se lanzan las sincronizaciones. */
window.INTEG = (function () {
  const I = { integ: [], plantillas: [], cola: [], log: [], entrantes: [], wa: null, zoho: null, metaPl: null, cargado: false };
  const g = () => puede('integraciones.gestionar');
  const fechaH = t => t ? new Date(t).toLocaleString('es-PA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  const row = s => I.integ.find(i => i.sistema === s) || {};
  const pillEstado = (e, txt) => `<span class="estado-pill ${e === 'conectado' ? 'ok' : e === 'error' ? 'crit' : 'warn'}"><i></i>${esc(txt || { conectado: 'Conectado', error: 'Con error', sin_configurar: 'Sin configurar' }[e] || e || '—')}</span>`;
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
    const wa = I.wa || {}, sec = wa.secretos || {};
    const zo = I.zoho || {};
    body.innerHTML = `<div class="integ-grid">
    <div class="card"><div class="hd"><div><h2>WhatsApp Business</h2><div class="sub">Avisos a clientes al salir la ruta y por demoras, con plantillas aprobadas por Meta.</div></div>${pillEstado(W.estado)}</div>
      <div class="stack">
        <label class="row"><input type="checkbox" id="wa-activo" ${W.activo ? 'checked' : ''} ${g() ? '' : 'disabled'}> <b>Envío real activado</b> <span class="note">Apagado: los avisos quedan como "simulado".</span></label>
        ${wa.numero ? `<dl class="kv"><dt>Número</dt><dd>${esc(wa.numero.display_phone_number)} · ${esc(wa.numero.verified_name || '')}</dd><dt>Calidad</dt><dd>${esc(wa.numero.quality_rating || '—')}</dd><dt>API</dt><dd>${esc(wa.api || '')}</dd></dl>` : wa.error ? `<div class="alert crit"><span class="dot"></span><div><b>Meta rechazó la conexión</b><small>${esc(wa.error)}</small></div></div>` : wa.fallo ? `<div class="alert warn"><span class="dot"></span><div><b>Edge Function "whatsapp" no responde</b><small>${esc(wa.fallo)}</small></div></div>` : '<p class="note">Comprobando conexión…</p>'}
        <details><summary class="mini"><b>Configuración (secretos en Supabase → Edge Functions → whatsapp)</b></summary><ul class="mini" style="list-style:none;padding:0;margin:8px 0">${['WA_TOKEN', 'WA_PHONE_NUMBER_ID', 'WA_VERIFY_TOKEN', 'WA_APP_SECRET', 'WA_CRON_SECRET', 'WA_WABA_ID'].map(k => check(sec[k], k)).join('')}</ul>
          <div class="mini">Webhook para Meta (WhatsApp → Configuración → Webhook): <span class="code">${esc(wa.webhook || '…/functions/v1/whatsapp')}</span>, token de verificación = WA_VERIFY_TOKEN, suscribir el campo <span class="code">messages</span>.</div></details>
        <div class="grid g4">${[['Pendientes', cnt('pendiente') + cnt('enviando')], ['Enviados', cnt('enviado') + cnt('entregado') + cnt('leido')], ['Leídos', cnt('leido')], ['Con problema', cnt('error') + cnt('fallido') + cnt('sin_telefono') + cnt('sin_plantilla')]].map(k => `<div class="tile"><div class="l">${k[0]}</div><div class="v" style="font-size:20px">${k[1]}</div><div class="s">últimas 48 h</div></div>`).join('')}</div>
        ${g() ? `<div class="row"><button class="btn sm" id="wa-diag">Probar conexión</button><button class="btn sm sec" id="wa-proc">Procesar pendientes</button><button class="btn sm sec" id="wa-test">Mensaje de prueba</button></div>` : ''}
      </div></div>
    <div class="card"><div class="hd"><div><h2>Zoho Books · Inventory</h2><div class="sub">Clientes, artículos y órdenes de venta entran desde Zoho; el envío verificado (paso 7) se registra en Inventory.</div></div>${pillEstado(ZI.estado === 'conectado' || ZB.estado === 'conectado' ? 'conectado' : ZI.estado === 'error' || ZB.estado === 'error' ? 'error' : 'sin_configurar')}</div>
      <div class="stack">
        ${zo.faltan && zo.faltan.length ? `<div class="alert warn"><span class="dot"></span><div><b>Faltan credenciales</b><small>Secretos de la Edge Function "zoho": ${zo.faltan.map(esc).join(', ')}. Centro de datos: ${esc(zo.dc || 'com')}.</small></div></div>` : zo.ok ? `<dl class="kv"><dt>Organización</dt><dd>${(zo.organizaciones || []).map(o => `${esc(o.nombre)} (${esc(o.id)}, ${esc(o.moneda)})`).join('<br>')}</dd><dt>Centro de datos</dt><dd>zoho.${esc(zo.dc)}</dd></dl>` : zo.error ? `<div class="alert crit"><span class="dot"></span><div><b>Zoho rechazó la conexión</b><small>${esc(zo.error)}</small></div></div>` : zo.fallo ? `<div class="alert warn"><span class="dot"></span><div><b>Edge Function "zoho" no responde</b><small>${esc(zo.fallo)}</small></div></div>` : '<p class="note">Comprobando conexión…</p>'}
        <label class="row"><input type="checkbox" id="zo-activo" ${ZI.activo ? 'checked' : ''} ${g() ? '' : 'disabled'}> <b>Registrar envíos reales en Zoho Inventory</b> <span class="note">Apagado: el paso 7 queda simulado.</span></label>
        ${g() ? `<div class="row"><label class="mini">Cambios desde <input type="date" id="zo-desde"></label><button class="btn sm" data-sync="sync_clientes">Sincronizar clientes</button><button class="btn sm" data-sync="sync_articulos">Artículos</button><button class="btn sm" data-sync="sync_pedidos">Órdenes de venta</button><button class="btn sm sec" id="zo-diag">Probar</button></div>
        <details><summary class="mini"><b>Mapeo de campos</b></summary><div class="stack" style="margin-top:8px">
          <label class="f">Código de cliente<select id="zo-codigo"><option value="contact_number">Número de contacto de Zoho</option><option value="contact_id">ID de Zoho</option></select></label>
          <label class="f">Las cantidades de Zoho están en<select id="zo-unidad"><option value="caja">Cajas</option><option value="unidad">Unidades (se convierten con unidades por caja)</option></select></label>
          <label class="f">Campo personalizado del ejecutivo de cuenta (api_name)<input id="zo-ejec" placeholder="cf_ejecutivo"></label>
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
    const ZI = row('zoho_inventory');
    const cfgZ = Object.assign({}, ZI.config || {});
    if ($('zo-codigo')) { $('zo-codigo').value = cfgZ.codigo_cliente || 'contact_number'; $('zo-unidad').value = cfgZ.unidad_zoho || 'caja'; $('zo-ejec').value = cfgZ.campo_ejecutivo || ''; }
    const toggle = (id, sistema, txt) => { const e = $(id); if (!e) return; e.onchange = async () => { try { await DB.update('integraciones', { sistema }, { activo: e.checked, updated_at: new Date().toISOString() }); await DB.audit('integraciones', e.checked ? 'activada' : 'desactivada', `${txt} ${e.checked ? 'activado' : 'desactivado'}`, ACTOR, false, sistema); toast(`${txt}: ${e.checked ? 'activado' : 'desactivado'}`); I.cargado = false; render(); } catch (x) { e.checked = !e.checked; toast(Auth.errorTexto(x)); } }; };
    toggle('wa-activo', 'whatsapp', 'Envío real de WhatsApp'); toggle('zo-activo', 'zoho_inventory', 'Registro de envíos en Zoho Inventory');
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
    on('zo-map', async () => { const c = Object.assign({}, cfgZ, { codigo_cliente: $('zo-codigo').value, unidad_zoho: $('zo-unidad').value, campo_ejecutivo: $('zo-ejec').value.trim() || null }); try { await DB.update('integraciones', { sistema: ['zoho_inventory', 'zoho_books'] }, { config: c }); toast('Mapeo guardado'); I.cargado = false; render(); } catch (e) { toast(Auth.errorTexto(e)); } });
  }
  return { render, recargar: () => { I.cargado = false; return render(); } };
})();
