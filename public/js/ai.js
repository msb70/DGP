/* DGP · Servicios de IA (LLM). La IA propone; el humano aprueba; todo queda auditado.
   Configuración (pantalla "Conexión y app móvil" o js/config.js → DGP_CONFIG.ai):
     endpoint: URL de un proxy (Supabase Edge Function supabase/functions/ia) que guarda la clave en el servidor (recomendado)
     key:      clave de API de Anthropic para llamar directo desde el navegador (solo demo)
     model:    modelo (por defecto claude-sonnet-4-5)
   Sin clave ni endpoint → modo simulado con reglas, marcado como tal. */
window.AI = (function () {
  const cfg = () => { const c = (window.DGP_CONFIG && window.DGP_CONFIG.ai) || {}; try { const s = JSON.parse(localStorage.getItem('dgp_ai') || 'null'); if (s) return Object.assign({}, c, s); } catch (e) { } return c; };
  const save = c => { try { localStorage.setItem('dgp_ai', JSON.stringify(c)); } catch (e) { } };
  const activo = () => { const c = cfg(); return !!(c.endpoint || c.key); };
  const modo = () => { const c = cfg(); return c.endpoint ? 'proxy' : c.key ? 'directo' : 'simulado'; };
  async function llm(system, user, maxTokens = 900) {
    const c = cfg(); const model = c.model || 'claude-sonnet-4-5';
    const body = { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] };
    let r;
    if (c.endpoint) r = await fetch(c.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    else if (c.key) r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': c.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify(body) });
    else throw new Error('IA no configurada');
    if (!r.ok) throw new Error('IA: ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json(); const t = (j.content && j.content[0] && j.content[0].text) || j.text || '';
    const m = t.match(/\{[\s\S]*\}/); if (!m) throw new Error('IA: respuesta sin JSON'); return JSON.parse(m[0]);
  }
  // ---------- 1. Normalización de direcciones ----------
  const SYS_DIR = `Eres un especialista en direcciones de la República de Panamá para una empresa de distribución. Recibes el nombre de un cliente y su dirección tal como está en el CRM (a veces con referencias como "frente a", "al lado de", "vía", "PH", "local"). Devuelve SOLO un JSON con:
{"direccion_normalizada": "dirección estructurada y completa en una línea", "corregimiento": "", "distrito": "", "provincia": "", "referencia": "referencia útil para el conductor o vacío", "consulta_geocodificacion": "texto corto y preciso para buscar en OpenStreetMap/Nominatim (nombre del negocio + vía o corregimiento + ciudad)", "confianza": 0.0-1.0, "notas": "qué asumiste o qué falta"}. No inventes números de calle. Si la dirección es ambigua, baja la confianza y explica en notas.`;
  async function normalizarDireccion(c, zonaNombre) {
    if (!activo()) return simNormalizar(c, zonaNombre);
    return llm(SYS_DIR, `Cliente: ${c.nombre}\nZona operativa: ${zonaNombre || c.zona_codigo || ''}\nDirección en CRM: ${c.direccion || '(vacía)'}\nCoordenada actual (estado ${c.geo_estado}): ${c.lat ?? '—'}, ${c.lng ?? '—'}`);
  }
  function simNormalizar(c, zonaNombre) {
    const d = (c.direccion || '').replace(/\s+/g, ' ').trim(); const partes = c.nombre.split(' · '); const nombre = partes[0]; const sector = partes[1] || (zonaNombre || 'Panamá').split(' · ')[0];
    const oeste = /chorrera|arraij|westland|vista alegre/i.test(sector + ' ' + (zonaNombre || '')); const distrito = /chorrera/i.test(sector) ? 'La Chorrera' : oeste ? 'Arraiján' : 'Panamá';
    const dir = [nombre, sector !== distrito ? sector : null, distrito, oeste ? 'Panamá Oeste' : 'Ciudad de Panamá', 'Panamá'].filter(Boolean).join(', ');
    return { direccion_normalizada: dir, corregimiento: sector, distrito, provincia: oeste ? 'Panamá Oeste' : 'Panamá', referencia: d && d !== dir ? d.slice(0, 80) : '', consulta_geocodificacion: `${nombre} ${sector} Panamá`, confianza: 0.55, notas: 'Modo simulado (sin clave de IA): normalización por reglas; con el modelo real se interpretan referencias y se eleva la confianza.' };
  }
  // ---------- 2. Triage de excepciones ----------
  const SYS_TRI = `Eres el asistente de la torre de control logística de Distribuidora General de Panamá (DGP). Recibes un pedido que quedó en la bandeja de excepciones y las reglas vigentes. Devuelve SOLO un JSON:
{"categoria": "monto_minimo|credito|direccion|ventana|capacidad|otro", "accion_recomendada": "agrupar|diferir|liberar_credito|corregir_direccion|autorizar|cancelar", "prioridad": "alta|media|baja", "justificacion": "1-2 frases con los datos del caso", "mensaje_ejecutivo": "mensaje breve de WhatsApp para el ejecutivo de cuenta, tono profesional panameño, con qué debe hacer y para cuándo", "mensaje_cliente": "mensaje breve de WhatsApp para el cliente si aplica, o vacío", "siguiente_paso_sistema": "qué hará la plataforma si el humano aprueba"}. Usa B/. para montos. No prometas fechas que no estén en los datos.`;
  async function triage(p, c, reglas, otrosDelCliente) {
    if (!activo()) return simTriage(p, c, reglas, otrosDelCliente);
    return llm(SYS_TRI, `Pedido ${p.numero_so} / factura ${p.numero_factura}\nCliente: ${c.nombre} (ejecutivo: ${c.ejecutivo})\nValor: B/. ${p.valor} · ${p.cajas} cajas\nCausa de excepción: ${p.causa}\nCrédito bloqueado: ${c.credito_bloqueado ? 'sí' : 'no'} · Estado de dirección: ${c.geo_estado} · Ventana: ${c.ventana_inicio ? c.ventana_inicio + '-' + c.ventana_fin : 'sin ventana'}\nOtros pedidos del mismo cliente hoy: ${otrosDelCliente.map(o => o.numero_so + ' B/. ' + o.valor + ' (' + o.estado + ')').join(', ') || 'ninguno'}\nReglas: mínimo por entrega B/. ${(reglas.monto_minimo || {}).valor || 40}; límite por vehículo B/. ${(reglas.cap_valor || {}).valor || 2500}; escalamiento a las ${(reglas.escalamiento_excepcion || {}).horas || 2} h.`);
  }
  function simTriage(p, c, reglas, otros) {
    const min = (reglas.monto_minimo || {}).valor || 40; const causa = p.causa || '';
    if (/crédito/i.test(causa)) return { categoria: 'credito', accion_recomendada: 'liberar_credito', prioridad: 'alta', justificacion: `${c.nombre} tiene crédito bloqueado en Books; el pedido de B/. ${p.valor} no sale hasta que CxC libere.`, mensaje_ejecutivo: `Hola ${c.ejecutivo.split(' ')[0]}, el pedido ${p.numero_so} de ${c.nombre} (B/. ${p.valor}) quedó retenido por crédito bloqueado. ¿Puedes gestionar con el cliente una promesa de pago hoy antes de las 15:00 para incluirlo en la ruta de mañana?`, mensaje_cliente: `Estimado cliente, su pedido ${p.numero_factura} está listo pero pendiente de autorización de crédito. Su ejecutivo ${c.ejecutivo} le contactará hoy para coordinar.`, siguiente_paso_sistema: 'Al aprobar: se notifica a CxC y al ejecutivo; el pedido queda diferido hasta la liberación.', simulado: true };
    if (/dirección|direccion/i.test(causa)) return { categoria: 'direccion', accion_recomendada: 'corregir_direccion', prioridad: 'media', justificacion: `La dirección de ${c.nombre} no está validada (${c.geo_estado}); sin coordenada confiable no se puede secuenciar.`, mensaje_ejecutivo: `Hola ${c.ejecutivo.split(' ')[0]}, necesito confirmar la ubicación exacta de ${c.nombre} para el pedido ${p.numero_so}. ¿Me envías la ubicación de WhatsApp o una referencia del punto de entrega? Con eso lo meto en ruta mañana.`, mensaje_cliente: '', siguiente_paso_sistema: 'Al aprobar: se notifica al ejecutivo y se abre la normalización asistida en Catálogo.', simulado: true };
    const tot = otros.reduce((s, o) => s + +o.valor, +p.valor);
    if (tot >= min && otros.length) return { categoria: 'monto_minimo', accion_recomendada: 'agrupar', prioridad: 'baja', justificacion: `Sumando los pedidos de hoy del cliente (B/. ${tot.toFixed(2)}) se supera el mínimo de B/. ${min}.`, mensaje_ejecutivo: `Hola ${c.ejecutivo.split(' ')[0]}, el pedido ${p.numero_so} de ${c.nombre} es de B/. ${p.valor} (< mínimo). Lo agrupo con sus otros pedidos de hoy para entregarlo en la misma parada, ¿de acuerdo?`, mensaje_cliente: '', siguiente_paso_sistema: 'Al aprobar: los pedidos se marcan como grupo y salen en la misma parada.', simulado: true };
    return { categoria: 'monto_minimo', accion_recomendada: 'diferir', prioridad: 'baja', justificacion: `Pedido de B/. ${p.valor} por debajo del mínimo de B/. ${min} y sin otros pedidos del cliente para agrupar.`, mensaje_ejecutivo: `Hola ${c.ejecutivo.split(' ')[0]}, el pedido ${p.numero_so} de ${c.nombre} es de B/. ${p.valor} y no alcanza el mínimo de entrega de B/. ${min}. ¿Puedes ofrecerle completar el pedido hoy, o lo diferimos para acumularlo con el próximo?`, mensaje_cliente: `Estimado cliente, su pedido ${p.numero_factura} (B/. ${p.valor}) está por debajo del mínimo de entrega de B/. ${min}. Si desea agregar productos hoy, lo despachamos mañana sin costo adicional.`, siguiente_paso_sistema: 'Al aprobar: se notifica al ejecutivo y el pedido queda diferido hasta completar el mínimo.', simulado: true };
  }
  return { cfg, save, activo, modo, normalizarDireccion, triage };
})();
