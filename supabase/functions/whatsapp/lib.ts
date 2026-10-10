// Funciones puras (probadas con deno test en tests/edge)
// Construye el mensaje de la API a partir de una fila de notificaciones
export function payload(n: any, pl: any | null) {
  const to = String(n.telefono || "").replace(/\D/g, "");
  if (pl) {
    const params = (Array.isArray(n.parametros) ? n.parametros : []).map((v: unknown) => ({ type: "text", text: String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 1000) || "-" }));
    return { messaging_product: "whatsapp", to, type: "template", template: { name: pl.nombre_meta, language: { code: pl.idioma || "es" }, components: params.length ? [{ type: "body", parameters: params }] : [] } };
  }
  return { messaging_product: "whatsapp", to, type: "text", text: { preview_url: false, body: String(n.mensaje || "").slice(0, 4096) } };
}


// Conexión desde la plataforma: interpreta la respuesta de GET /debug_token del token pegado por DGP.
// Devuelve la app, las cuentas de WhatsApp (WABA) a las que el token tiene acceso, los permisos que faltan y la caducidad.
export const PERMISOS_WA = ["whatsapp_business_messaging", "whatsapp_business_management"];
export function analizarToken(d: any) {
  const data = d?.data || d || {};
  const scopes: string[] = data.scopes || [];
  const gran: any[] = data.granular_scopes || [];
  const wabas = [...new Set(gran.filter((g) => PERMISOS_WA.includes(g.scope)).flatMap((g) => g.target_ids || []).map(String))];
  const exp = Number(data.expires_at) || 0;
  return {
    valido: !!data.is_valid, app_id: data.app_id ? String(data.app_id) : null as string | null, tipo: data.type || null,
    faltan: PERMISOS_WA.filter((p) => !scopes.includes(p)), wabas,
    expira: exp > 0 ? new Date(exp * 1000).toISOString() : null,   // null = permanente (usuario del sistema)
  };
}
// Formato del token y de la clave secreta antes de llamar a Meta (evita gastar llamadas con lo que no es)
export function validarEntrada(token: unknown, secreto: unknown) {
  const t = String(token || "").replace(/^Bearer\s+/i, "").trim(); const s = String(secreto || "").trim();
  if (!t) return { error: "Pega el token del usuario del sistema" };
  if (!/^[A-Za-z0-9_\-|.]{40,}$/.test(t)) return { error: "Eso no parece un token de Meta (suele empezar por EAA y tener más de 100 caracteres)" };
  if (!/^[0-9a-f]{32}$/i.test(s)) return { error: "La clave secreta de la app son 32 caracteres (0-9, a-f): Meta for Developers → tu app → Configuración → Básica → Clave secreta de la app" };
  return { token: t, secreto: s.toLowerCase() };
}
