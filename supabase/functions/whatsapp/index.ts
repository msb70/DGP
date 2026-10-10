// DGP · Edge Function "whatsapp": WhatsApp Business Cloud API (Meta).
//  GET  ?hub.mode=subscribe…        → verificación del webhook (WA_VERIFY_TOKEN)
//  POST con X-Hub-Signature-256      → webhook de Meta: estados (enviado/entregado/leído/fallido) y mensajes entrantes
//  POST {accion:"procesar", ids?}    → envía los avisos pendientes (usuario con sesión, o cabecera x-dgp-cron = WA_CRON_SECRET)
//  POST {accion:"estado"}            → diagnóstico de la conexión (integraciones.gestionar)
//  POST {accion:"prueba", telefono, plantilla?, parametros?, texto?} → mensaje de prueba (integraciones.gestionar)
//  POST {accion:"plantillas_meta"}   → plantillas aprobadas en WhatsApp Manager
//  POST {accion:"conectar", token, app_secret} → conexión desde Integraciones: detecta app, cuenta (WABA) y número, registra el
//                                    webhook y suscribe la cuenta; queda en dgp_private.wa_conexion (integraciones.gestionar)
//  POST {accion:"elegir_numero", phone_number_id} → si la cuenta tiene varios números                      (integraciones.gestionar)
// Despliegue: supabase functions deploy whatsapp --no-verify-jwt   (el webhook de Meta no envía JWT; la función valida cada caso)
// Credenciales: las de la conexión guardada desde la plataforma. Respaldo (si no hay conexión): secretos WA_TOKEN,
//   WA_PHONE_NUMBER_ID, WA_VERIFY_TOKEN, WA_APP_SECRET, WA_CRON_SECRET, WA_WABA_ID. Opcional WA_API_VERSION (por defecto v25.0).
import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { analizarToken, payload, validarEntrada } from "./lib.ts";

const env = (k: string, d = "") => Deno.env.get(k) || d;
const CORS = { "Access-Control-Allow-Origin": env("ALLOWED_ORIGINS", "*").split(",")[0].trim(), "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-dgp-cron", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
const GRAPH = () => `${env("WA_GRAPH_BASE", "https://graph.facebook.com")}/${env("WA_API_VERSION", "v25.0")}`;  // WA_GRAPH_BASE solo para pruebas
const admin = () => createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

// Errores de Meta que no se arreglan reintentando
const PERMANENTES = new Set([131026, 131047, 131051, 132000, 132001, 132005, 132007, 132012, 133010, 100, 190]);

// Credenciales en uso: la conexión guardada desde la plataforma o, si no hay, los secretos de la función.
// Caché corta: varias instancias de la función pueden tardar hasta 30 s en ver una reconexión.
type Cfg = { token: string; phone: string; waba: string; appSecret: string; verify: string[]; cron: string[]; origen: "plataforma" | "secretos" | null; fila: any; proof: string };
let cache: { t: number; c: Cfg } | null = null;
async function hmacHex(secret: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg))), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function cfg(fresco = false): Promise<Cfg> {
  if (!fresco && cache && Date.now() - cache.t < 30000) return cache.c;
  let f: any = {};
  try { const { data, error } = await admin().rpc("wa_conexion_get"); if (!error && data) f = data; } catch { /* sin migración 10d: secretos */ }
  const db = !!(f.token && f.phone_number_id);
  const c: Cfg = {
    token: db ? f.token : env("WA_TOKEN"), phone: db ? f.phone_number_id : env("WA_PHONE_NUMBER_ID"), waba: db ? (f.waba_id || "") : env("WA_WABA_ID"),
    appSecret: db ? (f.app_secret || "") : env("WA_APP_SECRET"),
    verify: [f.verify_token, env("WA_VERIFY_TOKEN")].filter(Boolean), cron: [f.cron_secret, env("WA_CRON_SECRET")].filter(Boolean),
    origen: db ? "plataforma" : env("WA_TOKEN") ? "secretos" : null, fila: f, proof: "",
  };
  // Con la conexión de la plataforma cada llamada lleva appsecret_proof (obligatorio si la app exige la clave secreta)
  if (db && c.appSecret) c.proof = await hmacHex(c.appSecret, c.token);
  cache = { t: Date.now(), c }; return c;
}
const conProof = (url: string, c: Cfg) => c.proof ? url + (url.includes("?") ? "&" : "?") + "appsecret_proof=" + c.proof : url;
const graph = (c: Cfg, ruta: string, init: RequestInit = {}) => fetch(conProof(`${GRAPH()}/${ruta}`, c), { ...init, headers: { Authorization: `Bearer ${c.token}`, ...(init.headers || {}) } });

async function hmacOk(raw: string, firma: string | null) {
  const secret = (await cfg()).appSecret; if (!secret || !firma?.startsWith("sha256=")) return false;
  const hex = await hmacHex(secret, raw);
  const a = firma.slice(7); if (a.length !== hex.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ hex.charCodeAt(i); return d === 0;
}

async function usuario(req: Request) {
  const authz = req.headers.get("authorization") || ""; if (!authz.startsWith("Bearer ")) return null;
  const c = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), { global: { headers: { Authorization: authz } }, auth: { persistSession: false } });
  const { data } = await c.rpc("mi_perfil"); return data && data.activo ? data : null;
}

async function enviar(c: Cfg, body: unknown) {
  const r = await graph(c, `${c.phone}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.ok && j.messages?.[0]?.id) return { ok: true, id: j.messages[0].id as string };
  const e = j.error || {}; return { ok: false, code: Number(e.code) || r.status, msg: `${e.code || r.status} ${e.error_data?.details || e.message || "error desconocido"}` };
}

const SIN_CONEXION = "WhatsApp sin conectar: pega el token y la clave secreta de la app en Integraciones";
async function procesar(ids?: string[]) {
  const c = await cfg(); if (!c.token || !c.phone) return { error: SIN_CONEXION };
  const db = admin();
  const { data: filas, error } = await db.rpc("wa_tomar_pendientes", { n: 25, ids: ids && ids.length ? ids : null });
  if (error) return { error: error.message };
  const { data: pls } = await db.from("wa_plantillas").select("*").eq("activa", true);
  const porCodigo = new Map((pls || []).map((p: any) => [p.codigo, p]));
  let enviados = 0, errores = 0;
  for (const n of filas || []) {
    const pl = n.plantilla ? porCodigo.get(n.plantilla) || null : null;
    if (n.plantilla && !pl) { await db.from("notificaciones").update({ estado: "fallido", error: `Plantilla ${n.plantilla} inactiva o inexistente` }).eq("id", n.id); errores++; continue; }
    const r = await enviar(c, payload(n, pl));
    if (r.ok) { await db.from("notificaciones").update({ estado: "enviado", wa_message_id: r.id, enviado_at: new Date().toISOString(), error: null }).eq("id", n.id); enviados++; }
    else { await db.from("notificaciones").update({ estado: PERMANENTES.has(r.code!) || (n.intentos || 0) >= 3 ? "fallido" : "error", error: r.msg }).eq("id", n.id); errores++; }
  }
  await db.from("integraciones").update(errores && !enviados ? { estado: "error", ultimo_error: new Date().toISOString(), detalle: "Último lote con errores" } : enviados ? { estado: "conectado", ultimo_ok: new Date().toISOString(), detalle: null } : {}).eq("sistema", "whatsapp");
  return { procesados: (filas || []).length, enviados, errores };
}

// Conexión desde la plataforma (igual que Zoho): DGP pega el token permanente del usuario del sistema y la clave secreta de
// la app. Se valida contra Meta ANTES de guardar; una conexión fallida no toca la que ya funcionaba.
async function metaJson(r: Response) { const j = await r.json().catch(() => ({})); return { ok: r.ok && !j.error, j, error: j.error ? `${j.error.message || "error"}${j.error.code ? ` (código ${j.error.code})` : ""}` : (r.ok ? null : `HTTP ${r.status}`) }; }
async function conectar(actor: string, b: any) {
  const v: any = validarEntrada(b.token, b.app_secret); if (v.error) throw new Error(v.error);
  const proof = await hmacHex(v.secreto, v.token);
  // 1. ¿De qué app es este token? Luego se inspecciona con la credencial de esa app: si la clave secreta no es de la app,
  //    Meta lo rechaza aquí, antes de guardar nada.
  const app = await metaJson(await fetch(`${GRAPH()}/app?fields=id,name`, { headers: { Authorization: `Bearer ${v.token}` } }));
  if (!app.ok || !app.j.id) throw new Error(`Meta no acepta el token: ${app.error || "sin app"}. Copia de nuevo el token del usuario del sistema (Meta Business → Configuración del negocio → Usuarios del sistema → Generar token).`);
  const dbg = await metaJson(await fetch(`${GRAPH()}/debug_token?input_token=${encodeURIComponent(v.token)}`, { headers: { Authorization: `Bearer ${app.j.id}|${v.secreto}` } }));
  if (!dbg.ok) throw new Error(`La clave secreta no corresponde a la app «${app.j.name || app.j.id}» del token (${dbg.error}). Cópiala de Meta for Developers → esa app → Configuración → Básica.`);
  const t = analizarToken(dbg.j);
  if (!t.app_id) t.app_id = String(app.j.id);
  if (!t.valido) throw new Error("El token ya no es válido (caducado o revocado). Genera uno nuevo para el usuario del sistema.");
  if (t.faltan.length) throw new Error(`Al token le faltan permisos: ${t.faltan.join(", ")}. Al generarlo marca whatsapp_business_messaging y whatsapp_business_management.`);
  if (!t.wabas.length) throw new Error("El token no tiene asignada ninguna cuenta de WhatsApp Business. En Usuarios del sistema → Asignar activos, dale la cuenta de WhatsApp con control total.");
  const avisos: string[] = [];
  if (t.expira) avisos.push(`El token caduca el ${t.expira.slice(0, 10)}. Es un token temporal: para producción usa uno de usuario del sistema con caducidad «Nunca».`);
  // 2. Números de las cuentas. La clave secreta se comprueba aquí: Meta rechaza un appsecret_proof que no corresponde.
  const numeros: any[] = [];
  for (const w of t.wabas) {
    const r = await metaJson(await fetch(`${GRAPH()}/${w}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status&appsecret_proof=${proof}`, { headers: { Authorization: `Bearer ${v.token}` } }));
    if (!r.ok) { if (/appsecret_proof/i.test(r.error || "")) throw new Error("La clave secreta no corresponde a la app de este token. Cópiala de Meta for Developers → la app del token → Configuración → Básica."); throw new Error(`No se pudieron leer los números de la cuenta ${w}: ${r.error}`); }
    for (const n of r.j.data || []) numeros.push({ id: String(n.id), waba: String(w), numero: n.display_phone_number, nombre: n.verified_name, calidad: n.quality_rating || null });
  }
  if (!numeros.length) throw new Error("La cuenta de WhatsApp no tiene números registrados. Añade y verifica el número de DGP en WhatsApp Manager.");
  const elegido = numeros.length === 1 ? numeros[0] : null;
  const fila = (await cfg(true)).fila;
  if (!fila.verify_token) throw new Error("Falta ejecutar la migración 10d (supabase/migraciones/2026-10-10_whatsapp_10d.sql).");
  const callback = `${env("SUPABASE_URL")}/functions/v1/whatsapp`;
  // 3. Guardar ANTES de registrar el webhook: Meta llama al instante a la URL para comprobar el token de verificación.
  const datos = { token: v.token, app_secret: v.secreto, app_id: t.app_id, waba_id: elegido ? elegido.waba : t.wabas[0], phone_number_id: elegido ? elegido.id : null, numeros, token_expira: t.expira, dispatch_url: callback, webhook_ok: false };
  const { error: se } = await admin().rpc("wa_conexion_set", { d: datos, actor }); if (se) throw new Error("No se pudo guardar la conexión: " + se.message);
  cache = null;
  // 4. Webhook de la app (estados de entrega y respuestas de clientes) y suscripción de la(s) cuenta(s) a la app
  let webhook = true;
  const sub = await metaJson(await fetch(`${GRAPH()}/${t.app_id}/subscriptions`, { method: "POST", headers: { Authorization: `Bearer ${t.app_id}|${v.secreto}`, "content-type": "application/json" }, body: JSON.stringify({ object: "whatsapp_business_account", callback_url: callback, verify_token: fila.verify_token, fields: "messages", include_values: true }) }));
  if (!sub.ok) { webhook = false; avisos.push(`No se pudo registrar el webhook automáticamente (${sub.error}). Regístralo a mano con la URL y el token de verificación que aparecen abajo.`); }
  for (const w of t.wabas) {
    const r = await metaJson(await fetch(`${GRAPH()}/${w}/subscribed_apps?appsecret_proof=${proof}`, { method: "POST", headers: { Authorization: `Bearer ${v.token}` } }));
    if (!r.ok) { webhook = false; avisos.push(`No se pudo suscribir la cuenta ${w} a la app (${r.error}). Sin esto no llegan los estados de entrega ni las respuestas.`); }
  }
  await admin().rpc("wa_conexion_patch", { d: { webhook_ok: webhook } });
  await admin().from("integraciones").update(elegido ? { estado: "conectado", ultimo_ok: new Date().toISOString(), detalle: `${elegido.numero} · ${elegido.nombre || ""}` } : { estado: "sin_configurar", detalle: "Falta elegir el número" }).eq("sistema", "whatsapp");
  await admin().from("auditoria").insert({ entidad: "integraciones", accion: "whatsapp_conectado", detalle: `WhatsApp conectado desde la plataforma (app ${t.app_id}, ${numeros.length} número(s)${elegido ? `, ${elegido.numero}` : ""})`, actor, automatico: false });
  cache = null;
  return { ok: true, numero: elegido, numeros: elegido ? undefined : numeros, webhook, avisos };
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
        const { data: cur, error: ce } = await db.from("notificaciones").select("estado").eq("wa_message_id", s.id).maybeSingle(); if (ce) throw ce;
        if (cur && (orden[cur.estado] ?? 0) > (orden[patch.estado as string] ?? 0) && patch.estado !== "fallido") { delete patch.estado; }
        const { error: ue } = await db.from("notificaciones").update(patch).eq("wa_message_id", s.id); if (ue) throw ue;
      }
    }
    const contactos = new Map((v.contacts || []).map((c: any) => [c.wa_id, c.profile?.name]));
    for (const m of v.messages || []) {
      const tel = String(m.from || "");
      const local = tel.startsWith("507") ? tel.slice(3) : tel;
      const { data: cli } = await db.from("clientes").select("id,telefono").or(`telefono.ilike.%${local.slice(-8, -4)}%${local.slice(-4)}%`).limit(5);
      const match = (cli || []).find((c: any) => String(c.telefono || "").replace(/\D/g, "").endsWith(local.slice(-8)));
      const { error: ee } = await db.from("wa_entrantes").upsert({ wa_message_id: m.id, telefono: tel, nombre: contactos.get(tel) || null, tipo: m.type, texto: m.text?.body || m.button?.text || m.interactive?.button_reply?.title || null, payload: m, cliente_id: match?.id || null }, { onConflict: "wa_message_id" }); if (ee) throw ee;
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const u = new URL(req.url);
  // Verificación del webhook
  if (req.method === "GET") {
    const vt = u.searchParams.get("hub.verify_token") || "";
    if (u.searchParams.get("hub.mode") === "subscribe" && vt && (await cfg(true)).verify.includes(vt)) return new Response(u.searchParams.get("hub.challenge") || "", { status: 200 });
    return new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const raw = await req.text();
  // Webhook de Meta (firmado)
  const firma = req.headers.get("x-hub-signature-256");
  if (firma) {
    if (!(await hmacOk(raw, firma))) return new Response("firma inválida", { status: 401 });
    // WA-001: 200 solo si se guardó. Ante un fallo se responde 500 y Meta reintenta; el procesamiento es idempotente
    // (estados por wa_message_id sin retroceder, mensajes entrantes con upsert por wa_message_id).
    try { await webhook(raw); } catch (e) { console.error("webhook", e); return new Response("error temporal, reintentar", { status: 500 }); }
    return new Response("ok", { status: 200 });
  }
  let b: any; try { b = JSON.parse(raw || "{}"); } catch { return json({ error: "Cuerpo inválido" }, 400); }
  const xc = req.headers.get("x-dgp-cron") || "";
  const cron = !!xc && (await cfg()).cron.includes(xc);
  const yo = cron ? null : await usuario(req);
  if (!cron && !yo) return json({ error: "Sin sesión" }, 401);
  const p: string[] = yo?.permisos || [];
  try {
    if (b.accion === "procesar") {
      let ids: string[] | undefined = Array.isArray(b.ids) ? b.ids.slice(0, 50) : (b.id ? [b.id] : undefined);
      // KNOWN-WA-001: el envío masivo es del cron o de quien tiene "notificaciones.enviar". Los demás solo pueden pedir el
      // envío de avisos que ellos mismos crearon y que siguen pendientes.
      if (!cron && !p.includes("notificaciones.enviar")) {
        if (!ids?.length) return json({ error: "Indica los avisos a enviar" }, 403);
        const { data: mios, error: me } = await admin().from("notificaciones").select("id").in("id", ids).eq("creado_por", yo.id).eq("estado", "pendiente");
        if (me) return json({ error: me.message }, 500);
        ids = (mios || []).map((x: any) => x.id); if (!ids.length) return json({ procesados: 0, enviados: 0, errores: 0 });
      }
      return json(await procesar(ids));
    }
    if (!cron && !p.includes("integraciones.gestionar") && !(b.accion === "estado" && p.includes("ver.integraciones"))) return json({ error: "Tu rol no gestiona integraciones" }, 403);
    if (b.accion === "conectar") { if (cron) return json({ error: "No permitido" }, 403); try { return json(await conectar(yo.nombre || yo.email || "admin", b)); } catch (e) { return json({ error: (e as any).message }, 400); } }
    if (b.accion === "elegir_numero") {
      const c = await cfg(true); const n = (c.fila.numeros || []).find((x: any) => String(x.id) === String(b.phone_number_id || ""));
      if (!n) return json({ error: "Ese número no está en la cuenta conectada" }, 400);
      await admin().rpc("wa_conexion_patch", { d: { phone_number_id: n.id, waba_id: n.waba } }); cache = null;
      await admin().from("integraciones").update({ estado: "conectado", ultimo_ok: new Date().toISOString(), detalle: `${n.numero} · ${n.nombre || ""}` }).eq("sistema", "whatsapp");
      await admin().from("auditoria").insert({ entidad: "integraciones", accion: "whatsapp_numero", detalle: `Número de WhatsApp: ${n.numero}`, actor: yo?.nombre || yo?.email || "admin", automatico: false });
      return json({ ok: true, numero: n });
    }
    if (b.accion === "estado") {
      const c = await cfg(true); const f = c.fila; const gestiona = cron || p.includes("integraciones.gestionar");
      const { data: infra } = await admin().rpc("wa_infra").then((r: any) => r, () => ({ data: null }));
      const out: Record<string, unknown> = { origen: c.origen, conectado: !!(c.token && c.phone), falta_numero: !!(f.token && !f.phone_number_id),
        numeros: f.token && !f.phone_number_id ? f.numeros || [] : undefined, conectado_por: f.conectado_por || null, conectado_at: f.conectado_at || null,
        token_expira: f.token_expira || null, webhook_ok: c.origen === "plataforma" ? !!f.webhook_ok : null, infra: infra || null,
        migracion: !!f.verify_token, api: env("WA_API_VERSION", "v25.0"), webhook: `${env("SUPABASE_URL")}/functions/v1/whatsapp`,
        verify_token: gestiona ? (f.verify_token || env("WA_VERIFY_TOKEN") || null) : undefined };
      if (c.token && c.phone) {
        const r = await graph(c, `${c.phone}?fields=display_phone_number,verified_name,quality_rating,code_verification_status`);
        const j = await r.json().catch(() => ({})); out.numero = r.ok ? j : null; out.error = r.ok ? null : (j.error?.message || `HTTP ${r.status}`);
        await admin().from("integraciones").update(r.ok ? { estado: "conectado", ultimo_ok: new Date().toISOString(), detalle: `${j.display_phone_number} · ${j.verified_name}` } : { estado: "error", ultimo_error: new Date().toISOString(), detalle: out.error as string }).eq("sistema", "whatsapp");
      }
      return json(out);
    }
    if (b.accion === "prueba") {
      const c = await cfg(); if (!c.token || !c.phone) return json({ error: SIN_CONEXION }, 400);
      const db = admin(); const d = String(b.telefono || "").replace(/\D/g, ""); const tel = d.length === 7 || d.length === 8 ? "507" + d : d;
      if (tel.length < 10) return json({ error: "Teléfono no válido" }, 400);
      let pl = null; if (b.plantilla) { const { data } = await db.from("wa_plantillas").select("*").eq("codigo", b.plantilla).maybeSingle(); pl = data; if (!pl) return json({ error: "Plantilla no encontrada" }, 400); }
      const n = { telefono: tel, parametros: b.parametros || [], mensaje: b.texto || "Mensaje de prueba de la Torre de Control DGP." };
      const r = await enviar(c, payload(n, pl));
      await db.from("notificaciones").insert({ canal: "prueba", destinatario: tel, rol: "prueba", asunto: "Prueba WhatsApp", mensaje: pl ? pl.cuerpo : n.mensaje, motivo: "prueba de conexión", telefono: tel, plantilla: b.plantilla || null, parametros: b.parametros || null, estado: r.ok ? "enviado" : "fallido", wa_message_id: r.ok ? r.id : null, error: r.ok ? null : r.msg, enviado_at: r.ok ? new Date().toISOString() : null, creado_por: yo?.id || null });
      return json(r.ok ? { ok: true, id: r.id } : { ok: false, error: r.msg }, r.ok ? 200 : 400);
    }
    if (b.accion === "plantillas_meta") {
      const c = await cfg(); if (!c.token || !c.waba) return json({ error: c.token ? "Falta la cuenta de WhatsApp (WABA): vuelve a conectar" : SIN_CONEXION }, 400);
      const r = await graph(c, `${c.waba}/message_templates?fields=name,status,language,category,components&limit=200`);
      const j = await r.json(); if (!r.ok) return json({ error: j.error?.message || `HTTP ${r.status}` }, 400);
      return json({ plantillas: j.data || [] });
    }
    return json({ error: "Acción desconocida" }, 400);
  } catch (e) { return json({ error: (e as any)?.message || String(e) }, 500); }
});
