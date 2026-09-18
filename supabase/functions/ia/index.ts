// Supabase Edge Function: proxy de IA. Guarda la clave en el servidor (secreto ANTHROPIC_API_KEY).
// Despliegue: supabase functions deploy ia --no-verify-jwt  ·  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
// O desde el panel: Edge Functions → New function → pegar este archivo → Secrets → ANTHROPIC_API_KEY.
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY no configurada" }), { status: 500, headers: { ...CORS, "content-type": "application/json" } });
  const body = await req.json();
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: body.model || "claude-sonnet-4-5", max_tokens: Math.min(body.max_tokens || 900, 2000), system: body.system, messages: body.messages }) });
  return new Response(await r.text(), { status: r.status, headers: { ...CORS, "content-type": "application/json" } });
});
