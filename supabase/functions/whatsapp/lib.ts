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

