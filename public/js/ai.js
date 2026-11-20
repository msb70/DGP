/* DGP · Servicios de IA (LLM). La IA propone; el humano aprueba; todo queda auditado.
   Configuración (pantalla "Conexión y app móvil" o js/config.js → DGP_CONFIG.ai):
     endpoint: URL de un proxy (Supabase Edge Function supabase/functions/ia) que guarda la clave en el servidor (recomendado)
     key:      clave de API de Anthropic para llamar directo desde el navegador (solo demo)
     model:    modelo (por defecto claude-sonnet-4-5)
   Sin clave ni endpoint → modo simulado con reglas, marcado como tal. */
window.AI = (function () {
  const PROD = () => !!(window.DGP_CONFIG && window.DGP_CONFIG.produccion);
  /* En producción: siempre el proxy de la Edge Function "ia" del proyecto, con la sesión del usuario. Nunca una clave en el navegador. */
  const cfg = () => { const D = window.DGP_CONFIG || {}; const c = D.ai || {}; if (PROD()) return D.url && c.activa !== false ? { endpoint: c.endpoint || D.url.replace(/\/$/, '') + '/functions/v1/ia', model: c.model } : {}; try { const s = JSON.parse(localStorage.getItem('dgp_ai') || 'null'); if (s) return Object.assign({}, c, s); } catch (e) { } return c; };
  const save = c => { try { localStorage.setItem('dgp_ai', JSON.stringify(c)); } catch (e) { } };
  const activo = () => { const c = cfg(); return !!(c.endpoint || c.key); };
  const modo = () => { const c = cfg(); return c.endpoint ? 'proxy' : c.key ? 'directo' : 'simulado'; };
  async function llm(system, user, maxTokens = 900) {
    const c = cfg(); const model = c.model || 'claude-sonnet-4-5';
    const body = { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] };
    let r;
    if (c.endpoint) { const h = { 'content-type': 'application/json' }; const D = window.DGP_CONFIG || {}; if (window.Auth && Auth.activo) { h.authorization = 'Bearer ' + await Auth.token(); h.apikey = D.key; } r = await fetch(c.endpoint, { method: 'POST', headers: h, body: JSON.stringify(body) }); }
    else if (c.key && !PROD()) r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': c.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify(body) });
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
  return { cfg, save, activo, modo, normalizarDireccion };
})();
