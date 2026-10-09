// DGP · Edge Function "ia": proxy a la API de Anthropic. La clave queda en el servidor (secreto ANTHROPIC_API_KEY).
// v3: exige sesión (verify_jwt) y el permiso ia.usar; limita modelo, tokens y tamaño. Ya no es un proxy abierto.
// Despliegue: supabase functions deploy ia   (SIN --no-verify-jwt)
// Secretos: ANTHROPIC_API_KEY · opcional IA_MODEL (por defecto claude-sonnet-4-5), IA_MAX_TOKENS (por defecto 1500).
import { createClient } from "npm:@supabase/supabase-js@2.117.3";
const CORS = { "Access-Control-Allow-Origin": (Deno.env.get("ALLOWED_ORIGINS") || "*").split(",")[0].trim(), "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const authz = req.headers.get("authorization") || "";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authz } }, auth: { persistSession: false } });
  const { data: perfil } = await sb.rpc("mi_perfil");
  if (!perfil || !perfil.activo) return json({ error: "Sin sesión" }, 401);
  if (!(perfil.permisos || []).includes("ia.usar")) return json({ error: "Tu rol no usa la IA" }, 403);
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ error: "ANTHROPIC_API_KEY no configurada" }, 500);
  const raw = await req.text(); if (raw.length > 60000) return json({ error: "Solicitud demasiado grande" }, 413);
  let body: any; try { body = JSON.parse(raw); } catch { return json({ error: "Cuerpo inválido" }, 400); }
  if (!Array.isArray(body.messages) || !body.messages.length) return json({ error: "Faltan mensajes" }, 400);
  const max = Number(Deno.env.get("IA_MAX_TOKENS") || 1500);
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: Deno.env.get("IA_MODEL") || "claude-sonnet-4-5", max_tokens: Math.min(Number(body.max_tokens) || 900, max), system: typeof body.system === "string" ? body.system.slice(0, 8000) : undefined, messages: body.messages.slice(0, 6) }) });
  return new Response(await r.text(), { status: r.status, headers: { ...CORS, "content-type": "application/json" } });
});
