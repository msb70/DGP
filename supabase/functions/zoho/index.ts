// DGP · Edge Function "zoho": integración con Zoho Books / Inventory (US: zoho.com por defecto).
// Acciones (POST {accion}):
//   estado                         → secretos presentes, token y organizaciones visibles      (ver.integraciones)
//   sync_clientes  {desde?}        → contactos cliente de Books  → clientes                   (integraciones.gestionar)
//   sync_articulos {desde?}        → artículos de Inventory      → articulos                  (integraciones.gestionar)
//   sync_pedidos   {desde?}        → órdenes de venta abiertas   → pedidos + pedido_lineas    (integraciones.gestionar)
//   registrar_envio {paquete_id}   → paquete + envío en Inventory para la orden del paquete   (verificar)
// Despliegue: supabase functions deploy zoho   (verify_jwt activado)
// Secretos: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN (self client, scopes ZohoBooks.fullaccess.all,ZohoInventory.fullaccess.all),
//           ZOHO_ORG_ID (organization_id), opcional ZOHO_DC (com|eu|in|com.au|jp|ca; por defecto com), ZOHO_INVENTORY_ORG_ID si difiere.
import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { ACTUALIZABLE, dominios, mapArticulo, mapCliente, mapPedido, paqueteZoho } from "./mapeo.ts";

const env = (k: string, d = "") => Deno.env.get(k) || d;
const CORS = { "Access-Control-Allow-Origin": env("ALLOWED_ORIGINS", "*").split(",")[0].trim(), "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });
const admin = () => createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const D = () => { const d = dominios(env("ZOHO_DC", "com")); return { accounts: env("ZOHO_ACCOUNTS_URL", d.accounts), api: env("ZOHO_API_URL", d.api) }; };  // *_URL solo para pruebas
const faltan = () => ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN", "ZOHO_ORG_ID"].filter((k) => !env(k));

async function token(db: any): Promise<{ t: string; api: string }> {
  const { data } = await db.rpc("zoho_token_get");
  if (data?.access_token && new Date(data.expira).getTime() > Date.now() + 60_000) return { t: data.access_token, api: data.api_domain || D().api };
  const q = new URLSearchParams({ refresh_token: env("ZOHO_REFRESH_TOKEN"), client_id: env("ZOHO_CLIENT_ID"), client_secret: env("ZOHO_CLIENT_SECRET"), grant_type: "refresh_token" });
  const r = await fetch(`${D().accounts}/oauth/v2/token?${q}`, { method: "POST" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Zoho OAuth: ${j.error || r.status}. Revisa ZOHO_REFRESH_TOKEN, el client y el centro de datos (ZOHO_DC).`);
  const api = j.api_domain || D().api;
  await db.rpc("zoho_token_set", { tok: j.access_token, exp: new Date(Date.now() + (Number(j.expires_in) || 3600) * 1000).toISOString(), dom: api });
  return { t: j.access_token, api };
}

// Llamada con reintento ante límite de tasa (Zoho: ~100 req/min por organización)
async function zoho(db: any, app: "books" | "inventory", ruta: string, init: RequestInit = {}, params: Record<string, string> = {}) {
  const { t, api } = await token(db);
  const org = app === "inventory" ? env("ZOHO_INVENTORY_ORG_ID", env("ZOHO_ORG_ID")) : env("ZOHO_ORG_ID");
  const qs = new URLSearchParams({ organization_id: org, ...params });
  const base = app === "books" ? `${api}/books/v3` : `${api}/inventory/v1`;
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${base}${ruta}${ruta.includes("?") ? "&" : "?"}${qs}`, { ...init, headers: { Authorization: `Zoho-oauthtoken ${t}`, "content-type": "application/json", ...(init.headers || {}) } });
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 2000 * (i + 1))); continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || (j.code !== undefined && j.code !== 0)) throw new Error(`Zoho ${app} ${ruta}: ${j.message || r.status}`);
    return j;
  }
  throw new Error("Zoho: límite de tasa excedido, reintenta en un minuto");
}
async function paginar(db: any, app: "books" | "inventory", ruta: string, clave: string, params: Record<string, string> = {}, maxPag = 50) {
  const out: any[] = [];
  for (let page = 1; page <= maxPag; page++) {
    const j = await zoho(db, app, ruta, {}, { ...params, page: String(page), per_page: "200" });
    out.push(...(j[clave] || []));
    if (!j.page_context?.has_more_page) break;
  }
  return out;
}

async function conLog(db: any, sistema: string, entidad: string, direccion: string, actor: string, fn: (log: any) => Promise<void>) {
  const { data: fila } = await db.from("sync_log").insert({ sistema, entidad, direccion, actor }).select("id").single();
  const log = { leidos: 0, creados: 0, actualizados: 0, errores: 0, detalle: [] as string[] };
  try {
    await fn(log);
    await db.from("sync_log").update({ ...log, detalle: log.detalle.slice(0, 200), estado: log.errores ? "parcial" : "ok", fin: new Date().toISOString(), mensaje: `${log.leidos} leídos · ${log.creados} nuevos · ${log.actualizados} actualizados · ${log.errores} con error` }).eq("id", fila.id);
    await db.from("integraciones").update({ estado: "conectado", ultimo_ok: new Date().toISOString(), detalle: `${entidad}: ${log.leidos} leídos` }).eq("sistema", sistema);
    return { ok: true, ...log, detalle: log.detalle.slice(0, 30) };
  } catch (e) {
    const m = (e as any)?.message || String(e);
    await db.from("sync_log").update({ ...log, detalle: log.detalle.slice(0, 200), estado: "error", fin: new Date().toISOString(), mensaje: m }).eq("id", fila.id);
    await db.from("integraciones").update({ estado: "error", ultimo_error: new Date().toISOString(), detalle: m }).eq("sistema", sistema);
    throw e;
  }
}
const cfgDe = async (db: any, sistema: string) => ((await db.from("integraciones").select("config").eq("sistema", sistema).maybeSingle()).data?.config) || {};
// Filtro incremental en cliente (las listas traen last_modified_time); evita depender de parámetros distintos por módulo
const recientes = (l: any[], desde?: string) => desde ? l.filter((x) => !x.last_modified_time || String(x.last_modified_time).slice(0, 10) >= desde) : l;

async function syncClientes(db: any, actor: string, desde?: string) {
  const cfg = await cfgDe(db, "zoho_books");
  return conLog(db, "zoho_books", "clientes", "entrada", actor, async (log) => {
    const lista = recientes(await paginar(db, "books", "/contacts", "contacts", { contact_type: "customer" }), desde);
    log.leidos = lista.length;
    const { data: locales } = await db.from("clientes").select("id,codigo,zoho_contact_id");
    const porZ = new Map((locales || []).filter((c: any) => c.zoho_contact_id).map((c: any) => [c.zoho_contact_id, c]));
    const porCod = new Map((locales || []).map((c: any) => [c.codigo, c]));
    for (const c of lista) {
      const m = mapCliente(c, cfg); const ex: any = porZ.get(m.zoho_contact_id as string) || porCod.get(m.codigo as string);
      const { error } = ex ? await db.from("clientes").update({ ...m, updated_at: new Date().toISOString() }).eq("id", ex.id) : await db.from("clientes").insert({ ...m, geo_estado: "pendiente" });
      if (error) { log.errores++; log.detalle.push(`${m.codigo}: ${error.message}`); } else ex ? log.actualizados++ : log.creados++;
    }
  });
}
async function syncArticulos(db: any, actor: string, desde?: string) {
  return conLog(db, "zoho_inventory", "articulos", "entrada", actor, async (log) => {
    const lista = recientes(await paginar(db, "inventory", "/items", "items", { filter_by: "Status.Active" }), desde);
    log.leidos = lista.length;
    const { data: locales } = await db.from("articulos").select("id,sku,zoho_item_id");
    const porZ = new Map((locales || []).filter((a: any) => a.zoho_item_id).map((a: any) => [a.zoho_item_id, a]));
    const porSku = new Map((locales || []).map((a: any) => [a.sku, a]));
    for (const i of lista) {
      const m: any = mapArticulo(i); const ex: any = porZ.get(m.zoho_item_id) || porSku.get(m.sku);
      for (const k of ["peso_kg", "volumen_m3", "codigo_barras", "categoria"]) if (m[k] == null) delete m[k]; // no borrar datos logísticos cargados a mano
      const { error } = ex ? await db.from("articulos").update(m).eq("id", ex.id) : await db.from("articulos").insert(m);
      if (error) { log.errores++; log.detalle.push(`${m.sku}: ${error.message}`); } else ex ? log.actualizados++ : log.creados++;
    }
  });
}
async function syncPedidos(db: any, actor: string, desde?: string) {
  const cfg = await cfgDe(db, "zoho_inventory");
  return conLog(db, "zoho_inventory", "pedidos", "entrada", actor, async (log) => {
    const lista = recientes(await paginar(db, "inventory", "/salesorders", "salesorders", { filter_by: "Status.Confirmed" }, 20), desde);
    log.leidos = lista.length;
    const [{ data: clientes }, { data: arts }, { data: existentes }] = await Promise.all([
      db.from("clientes").select("id,zoho_contact_id").not("zoho_contact_id", "is", null), db.from("articulos").select("sku,peso_kg,volumen_m3,unidades_por_caja"),
      db.from("pedidos").select("id,zoho_salesorder_id,estado").not("zoho_salesorder_id", "is", null)]);
    const cli = new Map<string, string>((clientes || []).map((c: any) => [String(c.zoho_contact_id), String(c.id)]));
    const art: Record<string, any> = {}; (arts || []).forEach((a: any) => art[a.sku] = a);
    const ex = new Map((existentes || []).map((p: any) => [p.zoho_salesorder_id, p]));
    for (const s of lista) {
      const prev: any = ex.get(String(s.salesorder_id));
      if (prev && !ACTUALIZABLE.has(prev.estado)) continue;              // ya planificado o en ruta: manda la operación
      const cid = cli.get(String(s.customer_id));
      if (!cid) { log.errores++; log.detalle.push(`${s.salesorder_number}: cliente ${s.customer_name} no sincronizado (ejecuta clientes primero)`); continue; }
      const det = (await zoho(db, "inventory", `/salesorders/${s.salesorder_id}`)).salesorder;
      const m = mapPedido(det, cid, art, cfg);
      if (m.desconocidos.length) { log.errores++; log.detalle.push(`${m.pedido.numero_so}: artículos sin sincronizar ${m.desconocidos.join(", ")}`); continue; }
      let pid = prev?.id;
      if (prev) { const { error } = await db.from("pedidos").update({ ...m.pedido, updated_at: new Date().toISOString() }).eq("id", pid); if (error) { log.errores++; log.detalle.push(`${m.pedido.numero_so}: ${error.message}`); continue; } await db.from("pedido_lineas").delete().eq("pedido_id", pid); log.actualizados++; }
      else { const { data, error } = await db.from("pedidos").insert({ ...m.pedido, estado: "pendiente_validar" }).select("id").single(); if (error) { log.errores++; log.detalle.push(`${m.pedido.numero_so}: ${error.message}`); continue; } pid = data.id; log.creados++; }
      const { error: le } = await db.from("pedido_lineas").insert(m.lineas.map(({ conocido: _c, ...l }) => ({ ...l, pedido_id: pid })));
      if (le) { log.errores++; log.detalle.push(`${m.pedido.numero_so} líneas: ${le.message}`); }
    }
  });
}
async function registrarEnvio(db: any, actor: string, paqueteId: string) {
  const { data: q } = await db.from("paquetes").select("*").eq("id", paqueteId).single();
  if (!q) throw new Error("Paquete no encontrado");
  if (q.books_shipment_id && !String(q.books_shipment_id).startsWith("SIM-")) return { ok: true, ya: true, shipment_id: q.books_shipment_id };
  const { data: p } = await db.from("pedidos").select("zoho_salesorder_id,numero_so").eq("id", q.pedido_id).single();
  if (!p?.zoho_salesorder_id) throw new Error(`El pedido ${p?.numero_so || ""} no viene de Zoho (sin salesorder_id)`);
  return conLog(db, "zoho_inventory", "envios", "salida", actor, async (log) => {
    log.leidos = 1;
    const so = (await zoho(db, "inventory", `/salesorders/${p.zoho_salesorder_id}`)).salesorder;
    let pkgId = q.zoho_package_id;
    if (!pkgId) { const pk = await zoho(db, "inventory", "/packages", { method: "POST", body: JSON.stringify(paqueteZoho(so, q)) }, { salesorder_id: String(p.zoho_salesorder_id) }); pkgId = String(pk.package.package_id); await db.from("paquetes").update({ zoho_package_id: pkgId }).eq("id", q.id); }
    const sh = await zoho(db, "inventory", "/shipmentorders", { method: "POST", body: JSON.stringify({ shipment_number: `ENV-${q.numero}`, date: new Date().toISOString().slice(0, 10), delivery_method: "Flota DGP", tracking_number: q.numero, notes: `Ruta ${q.color_nombre || ""}` }) }, { package_ids: pkgId, salesorder_id: String(p.zoho_salesorder_id) });
    const sid = String(sh.shipmentorder?.shipment_id || sh.shipment_order?.shipment_id || "");
    await db.from("paquetes").update({ books_shipment_id: sid, books_registrado_at: new Date().toISOString(), books_registrado_por: actor, books_error: null }).eq("id", q.id);
    log.creados = 1; log.detalle.push(`${q.numero} → paquete ${pkgId}, envío ${sid}`);
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const authz = req.headers.get("authorization") || "";
  const yo = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), { global: { headers: { Authorization: authz } }, auth: { persistSession: false } });
  const { data: perfil } = await yo.rpc("mi_perfil");
  if (!perfil || !perfil.activo) return json({ error: "Sin sesión" }, 401);
  const p: string[] = perfil.permisos || []; const actor = perfil.nombre || perfil.email;
  let b: any; try { b = await req.json(); } catch { return json({ error: "Cuerpo inválido" }, 400); }
  const necesita = b.accion === "estado" ? ["ver.integraciones", "integraciones.gestionar"] : b.accion === "registrar_envio" ? ["verificar"] : ["integraciones.gestionar"];
  if (!necesita.some((x) => p.includes(x))) return json({ error: "Tu rol no tiene permiso para esta acción" }, 403);
  const db = admin();
  try {
    if (b.accion === "estado") {
      const out: any = { faltan: faltan(), dc: env("ZOHO_DC", "com"), org: env("ZOHO_ORG_ID") ? "configurado" : null };
      if (!out.faltan.length) {
        try { const j = await zoho(db, "books", "/organizations"); out.organizaciones = (j.organizations || []).map((o: any) => ({ id: o.organization_id, nombre: o.name, moneda: o.currency_code })); out.ok = true;
          await db.from("integraciones").update({ estado: "conectado", ultimo_ok: new Date().toISOString(), detalle: out.organizaciones.map((o: any) => o.nombre).join(", ") }).in("sistema", ["zoho_books", "zoho_inventory"]); }
        catch (e) { out.ok = false; out.error = (e as any).message; }
      }
      return json(out);
    }
    if (faltan().length) return json({ error: `Faltan secretos de Zoho: ${faltan().join(", ")}` }, 400);
    if (b.accion === "sync_clientes") return json(await syncClientes(db, actor, b.desde));
    if (b.accion === "sync_articulos") return json(await syncArticulos(db, actor, b.desde));
    if (b.accion === "sync_pedidos") return json(await syncPedidos(db, actor, b.desde));
    if (b.accion === "registrar_envio") return json(await registrarEnvio(db, actor, b.paquete_id));
    return json({ error: "Acción desconocida" }, 400);
  } catch (e) {
    if (b.accion === "registrar_envio" && b.paquete_id) await db.from("paquetes").update({ books_error: (e as any).message }).eq("id", b.paquete_id);
    return json({ error: (e as any)?.message || String(e) }, 500);
  }
});
