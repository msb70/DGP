// DGP · Edge Function "zoho": integración con Zoho Inventory + Books (por defecto) o solo Books (US: zoho.com por defecto).
// Producto: secreto ZOHO_PRODUCTO = inventory (por defecto: clientes de Books, artículos/órdenes/envíos de Inventory) | books.
// Acciones (POST {accion}):
//   estado                         → secretos presentes, conexión, token y organizaciones     (ver.integraciones)
//   conectar {codigo}              → canjea el código del Self Client (o el self_client.json pegado) por el refresh
//                                    token y lo guarda en dgp_private.zoho_token; detecta centro de datos y organización (integraciones.gestionar)
//   elegir_org {org_id}            → fija la organización si la cuenta ve varias                                  (integraciones.gestionar)
//   sync_clientes  {desde?}        → contactos cliente          → clientes                    (integraciones.gestionar)
//   sync_articulos {desde?}        → artículos activos          → articulos                   (integraciones.gestionar)
//   sync_pedidos   {desde?}        → órdenes de venta abiertas  → pedidos + pedido_lineas     (integraciones.gestionar)
//   registrar_envio {paquete_id}   → Inventory: paquete (cantidades verificadas) + envío
//                                    solo Books: comentario de despacho en la orden (+ campo personalizado opcional)   (verificar)
// Despliegue: supabase functions deploy zoho   (verify_jwt activado)
// Secretos: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET (Self Client de la cuenta de DGP). El refresh token, el centro de datos y la
//           organización se obtienen con "conectar" (scopes ZohoBooks.fullaccess.all,ZohoInventory.fullaccess.all) y viven en la base.
//           Respaldo opcional por secretos: ZOHO_REFRESH_TOKEN, ZOHO_ORG_ID, ZOHO_DC (com|eu|in|com.au|jp|ca|sa|uk), ZOHO_INVENTORY_ORG_ID.
import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { ACTUALIZABLE, comentarioEnvio, dominios, mapArticulo, mapCliente, mapPedido, paqueteZoho } from "./mapeo.ts";

const env = (k: string, d = "") => Deno.env.get(k) || d;
const CORS = { "Access-Control-Allow-Origin": env("ALLOWED_ORIGINS", "*").split(",")[0].trim(), "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });
const admin = () => createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const D = (dc?: string) => { const d = dominios(dc || env("ZOHO_DC", "com")); return { accounts: env("ZOHO_ACCOUNTS_URL", d.accounts), api: env("ZOHO_API_URL", d.api) }; };  // *_URL solo para pruebas
const DCS = ["com", "eu", "in", "com.au", "jp", "ca", "sa", "uk"];
const PROD = (): "books" | "inventory" => env("ZOHO_PRODUCTO", "inventory").toLowerCase() === "books" ? "books" : "inventory";
const SIS = () => PROD() === "inventory" ? "zoho_inventory" : "zoho_books";
// Conexión: la guardada en la base (botón "Conectar") manda; los secretos son respaldo.
async function conexion(db: any) {
  const { data } = await db.rpc("zoho_token_get"); const c: any = data || {};
  return { ...c, rt: c.refresh_token || env("ZOHO_REFRESH_TOKEN"), dc: c.dc || env("ZOHO_DC", "com"), org: c.org_id || env("ZOHO_ORG_ID"), origen: c.refresh_token ? "plataforma" : env("ZOHO_REFRESH_TOKEN") ? "secretos" : null };
}
const sinCliente = () => ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET"].filter((k) => !env(k));
const faltan = (c: any) => [...sinCliente(), ...(c.rt ? [] : ["conexión (código del Self Client)"]), ...(c.org ? [] : ["organización"])];

async function token(db: any): Promise<{ t: string; api: string; org: string }> {
  const c = await conexion(db);
  if (c.access_token && new Date(c.expira).getTime() > Date.now() + 60_000) return { t: c.access_token, api: c.api_domain || D(c.dc).api, org: c.org };
  if (!c.rt) throw new Error("Zoho no está conectado: pega el código del Self Client en Integraciones → Conectar con Zoho.");
  const q = new URLSearchParams({ refresh_token: c.rt, client_id: env("ZOHO_CLIENT_ID"), client_secret: env("ZOHO_CLIENT_SECRET"), grant_type: "refresh_token" });
  const r = await fetch(`${D(c.dc).accounts}/oauth/v2/token?${q}`, { method: "POST" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Zoho OAuth: ${j.error || r.status}. La conexión ya no es válida (token revocado, usuario desactivado o client cambiado): vuelve a conectar con un código nuevo.`);
  const api = j.api_domain || D(c.dc).api;
  await db.rpc("zoho_token_set", { tok: j.access_token, exp: new Date(Date.now() + (Number(j.expires_in) || 3600) * 1000).toISOString(), dom: api });
  return { t: j.access_token, api, org: c.org };
}

// Canje del código del Self Client (un solo uso, caduca en minutos). Acepta el código o el self_client.json completo.
async function conectar(db: any, actor: string, entrada: unknown) {
  if (sinCliente().length) throw new Error(`Faltan secretos de la función: ${sinCliente().join(", ")}`);
  let code = String(entrada ?? "").trim();
  if (code.startsWith("{")) {
    let j: any; try { j = JSON.parse(code); } catch { throw new Error("No se pudo leer el JSON pegado: pega el contenido completo de self_client.json o solo el código."); }
    if (j.client_id && String(j.client_id) !== env("ZOHO_CLIENT_ID")) throw new Error("Ese self_client.json es de otro Self Client: su client_id no coincide con ZOHO_CLIENT_ID.");
    code = String(j.code || "").trim();
  }
  if (!code || /\s/.test(code) || code.length < 20) throw new Error("Código vacío o incompleto. Copia el código entero (empieza por 1000.).");
  const dcs = env("ZOHO_DC") ? [env("ZOHO_DC")] : DCS;
  let res: any = null, dc = "", err = "";
  for (const d of dcs) {
    const q = new URLSearchParams({ grant_type: "authorization_code", client_id: env("ZOHO_CLIENT_ID"), client_secret: env("ZOHO_CLIENT_SECRET"), code });
    const r = await fetch(`${D(d).accounts}/oauth/v2/token?${q}`, { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (j.access_token) { res = j; dc = d; break; }
    err = j.error || String(r.status);
    if (err !== "invalid_client") break;                       // invalid_client = el client no existe en ese centro de datos: probar el siguiente
  }
  if (!res) throw new Error(err === "invalid_code" ? "Zoho rechazó el código: caducó o ya se usó. Generad uno nuevo (Self Client → Generate Code) y pegadlo enseguida."
    : err === "invalid_client" ? "ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET no corresponden a ningún Self Client de Zoho: revisa que sean los del Self Client de la cuenta de DGP."
    : `Zoho OAuth: ${err}`);
  if (!res.refresh_token) throw new Error("Zoho no devolvió refresh token (el código ya se había canjeado). Generad un código nuevo.");
  const api = res.api_domain || D(dc).api; const auth = { Authorization: `Zoho-oauthtoken ${res.access_token}` };
  const leer = async (ruta: string) => { const r = await fetch(`${api}${ruta}`, { headers: auth }); const j = await r.json().catch(() => ({})); return r.ok && (j.code === undefined || j.code === 0) ? j : null; };
  const books = await leer("/books/v3/organizations"); const inv = await leer("/inventory/v1/organizations");
  const orgs = ((books || inv)?.organizations || []).map((o: any) => ({ id: String(o.organization_id), nombre: o.name, moneda: o.currency_code }));
  const avisos: string[] = [];
  if (!books) avisos.push("Sin acceso a Zoho Books: falta el scope ZohoBooks.fullaccess.all o el usuario no tiene Books (los clientes no se podrán sincronizar).");
  if (!inv && PROD() === "inventory") avisos.push("Sin acceso a Zoho Inventory: falta el scope ZohoInventory.fullaccess.all o el usuario no tiene Inventory (artículos, órdenes y envíos fallarán).");
  if (!orgs.length) avisos.push("El usuario que generó el código no ve ninguna organización.");
  const org = orgs.length === 1 ? orgs[0].id : (env("ZOHO_ORG_ID") && orgs.some((o: any) => o.id === env("ZOHO_ORG_ID")) ? env("ZOHO_ORG_ID") : null);
  const { error: ge } = await db.rpc("zoho_conexion_set", { rt: res.refresh_token, dcx: dc, orgs, org, actor });
  if (ge) throw new Error(`Zoho aceptó el código pero no se pudo guardar la conexión: ${ge.message}. Genera un código nuevo y reintenta.`);
  await db.rpc("zoho_token_set", { tok: res.access_token, exp: new Date(Date.now() + (Number(res.expires_in) || 3600) * 1000).toISOString(), dom: api });
  const nombre = orgs.find((o: any) => o.id === org)?.nombre;
  await db.from("integraciones").update({ estado: org && !avisos.length ? "conectado" : "error", ultimo_ok: new Date().toISOString(), detalle: nombre ? `Conectado a ${nombre} (zoho.${dc})` : "Conectado: falta elegir organización" }).in("sistema", ["zoho_books", "zoho_inventory"]);
  await db.from("auditoria").insert({ entidad: "integraciones", accion: "zoho_conectado", detalle: `Conexión con Zoho (zoho.${dc})${nombre ? " · " + nombre : ""}${avisos.length ? " · avisos: " + avisos.length : ""}`, actor, automatico: false });
  return { ok: true, dc, organizaciones: orgs, org, avisos };
}

// Llamada con reintento ante límite de tasa (Zoho: ~100 req/min por organización)
async function zoho(db: any, app: "books" | "inventory", ruta: string, init: RequestInit = {}, params: Record<string, string> = {}) {
  const { t, api, org: o } = await token(db);
  const org = app === "inventory" ? env("ZOHO_INVENTORY_ORG_ID", o) : o;
  const qs = new URLSearchParams({ ...(org ? { organization_id: org } : {}), ...params });
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
  return conLog(db, SIS(), "articulos", "entrada", actor, async (log) => {
    const lista = recientes(await paginar(db, PROD(), "/items", "items", { filter_by: "Status.Active" }), desde);
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
  const cfg = await cfgDe(db, SIS());
  return conLog(db, SIS(), "pedidos", "entrada", actor, async (log) => {
    // Inventory: Status.Confirmed (la facturación no cambia el estado de la orden). Solo Books: Status.Open, configurable con
    // config.filtros_pedidos = ["Status.Open","Status.PartiallyInvoiced","Status.Invoiced"] si facturan antes de despachar.
    const filtros: string[] = PROD() === "inventory" ? ["Status.Confirmed"] : (Array.isArray(cfg.filtros_pedidos) && cfg.filtros_pedidos.length ? cfg.filtros_pedidos : ["Status.Open"]);
    const corte = new Date(Date.now() - (Number(cfg.dias_pedidos) || 30) * 86400_000).toISOString().slice(0, 10);   // no traer órdenes viejas olvidadas
    const vistos = new Set<string>(); const lista: any[] = [];
    for (const f of filtros) for (const s of recientes(await paginar(db, PROD(), "/salesorders", "salesorders", { filter_by: f }, 20), desde))
      if (!vistos.has(String(s.salesorder_id)) && String(s.date || "9999") >= corte) { vistos.add(String(s.salesorder_id)); lista.push(s); }
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
      const det = (await zoho(db, PROD(), `/salesorders/${s.salesorder_id}`)).salesorder;
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
  if (PROD() === "books") return conLog(db, "zoho_books", "envios", "salida", actor, async (log) => {
    log.leidos = 1;
    const so = (await zoho(db, "books", `/salesorders/${p.zoho_salesorder_id}`)).salesorder;
    const { data: ruta } = q.ruta_id ? await db.from("rutas").select("codigo,conductor").eq("id", q.ruta_id).maybeSingle() : { data: null };
    const texto = comentarioEnvio(so, q, { conductor: ruta?.conductor, ruta: ruta?.codigo || q.color_nombre, actor });
    const c = await zoho(db, "books", `/salesorders/${p.zoho_salesorder_id}/comments`, { method: "POST", body: JSON.stringify({ description: texto }) });
    const cid = String(c.comment?.comment_id || c.comment_id || "ok");
    // Opcional: marcar un campo personalizado de la orden (config.campo_despacho_id = customfield_id; valor = config.valor_despacho o "Despachado")
    const cfg = await cfgDe(db, "zoho_books");
    if (cfg.campo_despacho_id) {
      try { await zoho(db, "books", `/salesorder/${p.zoho_salesorder_id}/customfields`, { method: "PUT", body: JSON.stringify([{ customfield_id: String(cfg.campo_despacho_id), value: cfg.valor_despacho || "Despachado" }]) }); }
      catch (e) { log.errores++; log.detalle.push(`campo personalizado no actualizado: ${(e as any).message}`); }
    }
    const ref = `BOOKS-SO-${p.zoho_salesorder_id}-C${cid}`;
    await db.from("paquetes").update({ books_shipment_id: ref, books_registrado_at: new Date().toISOString(), books_registrado_por: actor, books_error: null }).eq("id", q.id);
    log.creados = 1; log.detalle.push(`${q.numero} → comentario de despacho en ${so.salesorder_number}`);
  });
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
    if (b.accion === "conectar") return json(await conectar(db, actor, b.codigo));
    if (b.accion === "elegir_org") {
      const c = await conexion(db); const o = (c.organizaciones || []).find((x: any) => x.id === String(b.org_id || ""));
      if (!o) return json({ error: "Organización no válida para esta conexión" }, 400);
      const { error: oe } = await db.rpc("zoho_org_set", { org: o.id }); if (oe) return json({ error: oe.message }, 500);
      await db.from("integraciones").update({ estado: "conectado", ultimo_ok: new Date().toISOString(), detalle: `Conectado a ${o.nombre}` }).in("sistema", ["zoho_books", "zoho_inventory"]);
      await db.from("auditoria").insert({ entidad: "integraciones", accion: "zoho_organizacion", detalle: `Organización de Zoho: ${o.nombre} (${o.id})`, actor, automatico: false });
      return json({ ok: true, org: o.id });
    }
    const c = await conexion(db);
    if (b.accion === "estado") {
      const out: any = { faltan: faltan(c), cliente: !sinCliente().length, conectado: !!c.rt, origen: c.origen, conectado_por: c.conectado_por || null, conectado_at: c.conectado_at || null,
        dc: c.dc, producto: PROD(), org: c.org || null, organizaciones_guardadas: c.organizaciones || [] };
      if (out.cliente && out.conectado) {
        try { const j = await zoho(db, "books", "/organizations"); out.organizaciones = (j.organizations || []).map((o: any) => ({ id: String(o.organization_id), nombre: o.name, moneda: o.currency_code })); out.ok = true;
          const sel = out.organizaciones.find((o: any) => o.id === c.org);
          if (sel) await db.from("integraciones").update({ estado: "conectado", ultimo_ok: new Date().toISOString(), detalle: sel.nombre }).in("sistema", ["zoho_books", "zoho_inventory"]); }
        catch (e) { out.ok = false; out.error = (e as any).message; }
      }
      return json(out);
    }
    if (faltan(c).length) return json({ error: `Zoho no está listo: falta ${faltan(c).join(", ")}` }, 400);
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
