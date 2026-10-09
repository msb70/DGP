// DGP · Edge Function "whatsapp": WhatsApp Business Cloud API (Meta).
//  GET  ?hub.mode=subscribe…        → verificación del webhook (WA_VERIFY_TOKEN)
//  POST con X-Hub-Signature-256      → webhook de Meta: estados (enviado/entregado/leído/fallido) y mensajes entrantes
//  POST {accion:"procesar", ids?}    → envía los avisos pendientes (usuario con sesión, o cabecera x-dgp-cron = WA_CRON_SECRET)
//  POST {accion:"estado"}            → diagnóstico de la conexión (integraciones.gestionar)
//  POST {accion:"prueba", telefono, plantilla?, parametros?, texto?} → mensaje de prueba (integraciones.gestionar)
//  POST {accion:"plantillas_meta"}   → plantillas aprobadas en WhatsApp Manager (requiere WA_WABA_ID)
// Despliegue: supabase functions deploy whatsapp --no-verify-jwt   (el webhook de Meta no envía JWT; la función valida cada caso)
// Secretos: WA_TOKEN (token permanente de usuario del sistema), WA_PHONE_NUMBER_ID, WA_VERIFY_TOKEN, WA_APP_SECRET,
//           WA_CRON_SECRET, opcionales WA_WABA_ID y WA_API_VERSION (por defecto v25.0).
import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { payload } from "./lib.ts";

const env = (k: string, d = "") => Deno.env.get(k) || d;
const CORS = { "Access-Control-Allow-Origin": env("ALLOWED_ORIGINS", "*").split(",")[0].trim(), "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-dgp-cron", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
const GRAPH = () => `${env("WA_GRAPH_BASE", "https://graph.facebook.com")}/${env("WA_API_VERSION", "v25.0")}`;  // WA_GRAPH_BASE solo para pruebas
const admin = () => createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

// Errores de Meta que no se arreglan reintentando
const PERMANENTES = new Set([131026, 131047, 131051, 132000, 132001, 132005, 132007, 132012, 133010, 100, 190]);

async function hmacOk(raw: string, firma: string | null) {
  const secret = env("WA_APP_SECRET"); if (!secret || !firma?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  const hex = Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
  const a = firma.slice(7); if (a.length !== hex.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ hex.charCodeAt(i); return d === 0;
}

async function usuario(req: Request) {
  const authz = req.headers.get("authorization") || ""; if (!authz.startsWith("Bearer ")) return null;
  const c = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), { global: { headers: { Authorization: authz } }, auth: { persistSession: false } });
  const { data } = await c.rpc("mi_perfil"); return data && data.activo ? data : null;
}

async function enviar(body: unknown) {
  const r = await fetch(`${GRAPH()}/${env("WA_PHONE_NUMBER_ID")}/messages`, { method: "POST", headers: { Authorization: `Bearer ${env("WA_TOKEN")}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.ok && j.messages?.[0]?.id) return { ok: true, id: j.messages[0].id as string };
  const e = j.error || {}; return { ok: false, code: Number(e.code) || r.status, msg: `${e.code || r.status} ${e.error_data?.details || e.message || "error desconocido"}` };
}

async function procesar(ids?: string[]) {
  if (!env("WA_TOKEN") || !env("WA_PHONE_NUMBER_ID")) return { error: "Faltan los secretos WA_TOKEN / WA_PHONE_NUMBER_ID" };
  const db = admin();
  const { data: filas, error } = await db.rpc("wa_tomar_pendientes", { n: 25, ids: ids && ids.length ? ids : null });
  if (error) return { error: error.message };
  const { data: pls } = await db.from("wa_plantillas").select("*").eq("activa", true);
  const porCodigo = new Map((pls || []).map((p: any) => [p.codigo, p]));
  let enviados = 0, errores = 0;
  for (const n of filas || []) {
    const pl = n.plantilla ? porCodigo.get(n.plantilla) || null : null;
    if (n.plantilla && !pl) { await db.from("notificaciones").update({ estado: "fallido", error: `Plantilla ${n.plantilla} inactiva o inexistente` }).eq("id", n.id); errores++; continue; }
    const r = await enviar(payload(n, pl));
    if (r.ok) { await db.from("notificaciones").update({ estado: "enviado", wa_message_id: r.id, enviado_at: new Date().toISOString(), error: null }).eq("id", n.id); enviados++; }
    else { await db.from("notificaciones").update({ estado: PERMANENTES.has(r.code!) || (n.intentos || 0) >= 3 ? "fallido" : "error", error: r.msg }).eq("id", n.id); errores++; }
  }
  await db.from("integraciones").update(errores && !enviados ? { estado: "error", ultimo_error: new Date().toISOString(), detalle: "Último lote con errores" } : enviados ? { estado: "conectado", ultimo_ok: new Date().toISOString(), detalle: null } : {}).eq("sistema", "whatsapp");
  return { procesados: (filas || []).length, enviados, errores };
}

async function webhook(raw: string) {
  const db = admin(); const ev = JSON.parse(raw);
  for (const entry of ev.entry || []) for (const ch of entry.changes || []) {
    const v = ch.value || {};
    for (const s of v.statuses || []) {
      const t = new Date(Number(s.timestamp) * 1000).toISOString(); const patch: Record<string, unknown> = {};
      if (s.status === "sent") { patch.estado = "enviado"; patch.enviado_at = t; }
      else if (s.status === "delivered") { patch.estado = "entregado"; patch.entregado_at = t; }
      else if (s.status === "read") { patch.estado = "leido"; patch.leido_at = t; }
      else if (s.status === "failed") { patch.estado = "fallido"; patch.error = (s.errors || []).map((e: any) => `${e.code} ${e.error_data?.details || e.title || ""}`).join("; "); }
      if (Object.keys(patch).length) {
        // no retroceder de "leido" a "entregado" si llegan desordenados
        const orden: Record<string, number> = { enviando: 0, enviado: 1, entregado: 2, leido: 3, fallido: 4 };
        const { data: cur } = await db.from("notificaciones").select("estado").eq("wa_message_id", s.id).maybeSingle();
        if (cur && (orden[cur.estado] ?? 0) > (orden[patch.estado as string] ?? 0) && patch.estado !== "fallido") { delete patch.estado; }
        await db.from("notificaciones").update(patch).eq("wa_message_id", s.id);
      }
    }
    const contactos = new Map((v.contacts || []).map((c: any) => [c.wa_id, c.profile?.name]));
    for (const m of v.messages || []) {
      const tel = String(m.from || "");
      const local = tel.startsWith("507") ? tel.slice(3) : tel;
      const { data: cli } = await db.from("clientes").select("id,telefono").or(`telefono.ilike.%${local.slice(-8, -4)}%${local.slice(-4)}%`).limit(5);
      const match = (cli || []).find((c: any) => String(c.telefono || "").replace(/\D/g, "").endsWith(local.slice(-8)));
      await db.from("wa_entrantes").upsert({ wa_message_id: m.id, telefono: tel, nombre: contactos.get(tel) || null, tipo: m.type, texto: m.text?.body || m.button?.text || m.interactive?.button_reply?.title || null, payload: m, cliente_id: match?.id || null }, { onConflict: "wa_message_id" });
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const u = new URL(req.url);
  // Verificación del webhook
  if (req.method === "GET") {
    if (u.searchParams.get("hub.mode") === "subscribe" && env("WA_VERIFY_TOKEN") && u.searchParams.get("hub.verify_token") === env("WA_VERIFY_TOKEN")) return new Response(u.searchParams.get("hub.challenge") || "", { status: 200 });
    return new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const raw = await req.text();
  // Webhook de Meta (firmado)
  const firma = req.headers.get("x-hub-signature-256");
  if (firma) {
    if (!(await hmacOk(raw, firma))) return new Response("firma inválida", { status: 401 });
    try { await webhook(raw); } catch (e) { console.error("webhook", e); }
    return new Response("ok", { status: 200 });   // Meta reintenta si no recibe 200
  }
  let b: any; try { b = JSON.parse(raw || "{}"); } catch { return json({ error: "Cuerpo inválido" }, 400); }
  const cron = env("WA_CRON_SECRET") && req.headers.get("x-dgp-cron") === env("WA_CRON_SECRET");
  const yo = cron ? null : await usuario(req);
  if (!cron && !yo) return json({ error: "Sin sesión" }, 401);
  const p: string[] = yo?.permisos || [];
  try {
    if (b.accion === "procesar") {
      if (!cron && !p.length) return json({ error: "Sin permiso" }, 403); // cualquier usuario activo que generó un aviso puede pedir su envío
      const ids = Array.isArray(b.ids) ? b.ids.slice(0, 50) : (b.id ? [b.id] : undefined);
      return json(await procesar(ids));
    }
    if (!cron && !p.includes("integraciones.gestionar") && !(b.accion === "estado" && p.includes("ver.integraciones"))) return json({ error: "Tu rol no gestiona integraciones" }, 403);
    if (b.accion === "estado") {
      const out: Record<string, unknown> = { secretos: { WA_TOKEN: !!env("WA_TOKEN"), WA_PHONE_NUMBER_ID: !!env("WA_PHONE_NUMBER_ID"), WA_VERIFY_TOKEN: !!env("WA_VERIFY_TOKEN"), WA_APP_SECRET: !!env("WA_APP_SECRET"), WA_CRON_SECRET: !!env("WA_CRON_SECRET"), WA_WABA_ID: !!env("WA_WABA_ID") }, api: env("WA_API_VERSION", "v25.0"), webhook: `${env("SUPABASE_URL")}/functions/v1/whatsapp` };
      if (env("WA_TOKEN") && env("WA_PHONE_NUMBER_ID")) {
        const r = await fetch(`${GRAPH()}/${env("WA_PHONE_NUMBER_ID")}?fields=display_phone_number,verified_name,quality_rating,code_verification_status`, { headers: { Authorization: `Bearer ${env("WA_TOKEN")}` } });
        const j = await r.json().catch(() => ({})); out.numero = r.ok ? j : null; out.error = r.ok ? null : (j.error?.message || `HTTP ${r.status}`);
        await admin().from("integraciones").update(r.ok ? { estado: "conectado", ultimo_ok: new Date().toISOString(), detalle: `${j.display_phone_number} · ${j.verified_name}` } : { estado: "error", ultimo_error: new Date().toISOString(), detalle: out.error as string }).eq("sistema", "whatsapp");
      }
      return json(out);
    }
    if (b.accion === "prueba") {
      if (!env("WA_TOKEN") || !env("WA_PHONE_NUMBER_ID")) return json({ error: "Faltan los secretos WA_TOKEN / WA_PHONE_NUMBER_ID" }, 400);
      const db = admin(); const d = String(b.telefono || "").replace(/\D/g, ""); const tel = d.length === 7 || d.length === 8 ? "507" + d : d;
      if (tel.length < 10) return json({ error: "Teléfono no válido" }, 400);
      let pl = null; if (b.plantilla) { const { data } = await db.from("wa_plantillas").select("*").eq("codigo", b.plantilla).maybeSingle(); pl = data; if (!pl) return json({ error: "Plantilla no encontrada" }, 400); }
      const n = { telefono: tel, parametros: b.parametros || [], mensaje: b.texto || "Mensaje de prueba de la Torre de Control DGP." };
      const r = await enviar(payload(n, pl));
      await db.from("notificaciones").insert({ canal: "prueba", destinatario: tel, rol: "prueba", asunto: "Prueba WhatsApp", mensaje: pl ? pl.cuerpo : n.mensaje, motivo: "prueba de conexión", telefono: tel, plantilla: b.plantilla || null, parametros: b.parametros || null, estado: r.ok ? "enviado" : "fallido", wa_message_id: r.ok ? r.id : null, error: r.ok ? null : r.msg, enviado_at: r.ok ? new Date().toISOString() : null, creado_por: yo?.id || null });
      return json(r.ok ? { ok: true, id: r.id } : { ok: false, error: r.msg }, r.ok ? 200 : 400);
    }
    if (b.accion === "plantillas_meta") {
      if (!env("WA_WABA_ID")) return json({ error: "Falta el secreto WA_WABA_ID" }, 400);
      const r = await fetch(`${GRAPH()}/${env("WA_WABA_ID")}/message_templates?fields=name,status,language,category,components&limit=200`, { headers: { Authorization: `Bearer ${env("WA_TOKEN")}` } });
      const j = await r.json(); if (!r.ok) return json({ error: j.error?.message || `HTTP ${r.status}` }, 400);
      return json({ plantillas: j.data || [] });
    }
    return json({ error: "Acción desconocida" }, 400);
  } catch (e) { return json({ error: (e as any)?.message || String(e) }, 500); }
});
