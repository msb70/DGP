// DGP · Edge Function "zoho": integración con Zoho Inventory + Books (por defecto) o solo Books (US: zoho.com por defecto).
// Producto: secreto ZOHO_PRODUCTO = inventory (por defecto: clientes de Books, artículos/órdenes/envíos de Inventory) | books.
// Acciones (POST {accion}):
//   estado                         → secretos presentes, conexión, token y organizaciones     (ver.integraciones)
//   conectar {codigo}              → canjea el código del Self Client (o el self_client.json pegado) por el refresh
//                                    token y lo guarda en dgp_private.zoho_token; detecta centro de datos y organización (integraciones.gestionar)
//   elegir_org {org_id}            → fija la organización si la cuenta ve varias                                  (integraciones.gestionar)
//   sync_clientes  {desde?,pagina?} → contactos cliente        → clientes   · por tramos de 4 páginas; devuelve `siguiente` (integraciones.gestionar)
//   sync_articulos {desde?,pagina?} → artículos activos        → articulos  · ídem
//   completar_direcciones {lote?}  → pide a Zoho el detalle de los clientes sin dirección (el listado no la trae); por lotes (integraciones.gestionar)
//   sync_pedidos   {desde?}        → órdenes de venta abiertas  → pedidos + pedido_lineas     (integraciones.gestionar)
//   registrar_envio {paquete_id}   → Inventory: paquete (cantidades verificadas) + envío
//                                    solo Books: comentario de despacho en la orden (+ campo personalizado opcional)   (verificar)
// Despliegue: supabase functions deploy zoho   (verify_jwt activado)
// Secretos: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET (Self Client de la cuenta de DGP). El refresh token, el centro de datos y la
//           organización se obtienen con "conectar" (scopes ZohoBooks.fullaccess.all,ZohoInventory.fullaccess.all) y viven en la base.
//           Respaldo opcional por secretos: ZOHO_REFRESH_TOKEN, ZOHO_ORG_ID, ZOHO_DC (com|eu|in|com.au|jp|ca|sa|uk), ZOHO_INVENTORY_ORG_ID.
import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { ACTUALIZABLE, buscarComentarioDespacho, buscarPaquete, comentarioEnvio, direccionDeContacto, dominios, mapArticulo, mapCliente, mapPedido, paqueteZoho } from "./mapeo.ts";

const env = (k: string, d = "") => Deno.env.get(k) || d;
const CORS = { "Access-Control-Allow-Origin": env("ALLOWED_ORIGINS", "*").split(",")[0].trim(), "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });
const admin = () => createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const D = (dc?: string) => { const d = dominios(dc || env("ZOHO_DC", "com")); return { accounts: env("ZOHO_ACCOUNTS_URL", d.accounts), api: env("ZOHO_API_URL", d.api) }; };  // *_URL solo para pruebas
const DCS = ["com", "eu", "in", "com.au", "jp", "ca", "sa", "uk"];
const PROD = (): "books" | "inventory" => env("ZOHO_PRODUCTO", "inventory").toLowerCase() === "books" ? "books" : "inventory";
const hoyPanama = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Panama" }).format(new Date());   // COD-06: fecha operativa
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
  const log: any = { leidos: 0, creados: 0, actualizados: 0, errores: 0, detalle: [] as string[] };
  try {
    await fn(log);
    const { siguiente, quedan, limite, sin_direccion, ...guardar } = log;
    await db.from("sync_log").update({ ...guardar, detalle: log.detalle.slice(0, 200), estado: log.errores ? "parcial" : "ok", fin: new Date().toISOString(), mensaje: `${log.leidos} leídos · ${log.creados} nuevos · ${log.actualizados} actualizados · ${log.errores} con error` }).eq("id", fila.id);
    await db.from("integraciones").update({ estado: "conectado", ultimo_ok: new Date().toISOString(), detalle: `${entidad}: ${log.leidos} leídos` }).eq("sistema", sistema);
    return { ok: true, ...log, detalle: log.detalle.slice(0, 30) };
  } catch (e) {
    const m = (e as any)?.message || String(e);
    const { siguiente: _s, quedan: _q, limite: _l, sin_direccion: _d, ...guardar } = log;
    await db.from("sync_log").update({ ...guardar, detalle: log.detalle.slice(0, 200), estado: "error", fin: new Date().toISOString(), mensaje: m }).eq("id", fila.id);
    await db.from("integraciones").update({ estado: "error", ultimo_error: new Date().toISOString(), detalle: m }).eq("sistema", sistema);
    throw e;
  }
}
const cfgDe = async (db: any, sistema: string) => ((await db.from("integraciones").select("config").eq("sistema", sistema).maybeSingle()).data?.config) || {};
// Filtro incremental en cliente (las listas traen last_modified_time); evita depender de parámetros distintos por módulo
const recientes = (l: any[], desde?: string) => desde ? l.filter((x) => !x.last_modified_time || String(x.last_modified_time).slice(0, 10) >= desde) : l;

// Lectura completa de una tabla local en bloques de 1000 (PostgREST corta en 1000 filas por consulta).
async function todos(db: any, tabla: string, cols: string, filtro?: (q: any) => any) {
  const out: any[] = [];
  for (let desde = 0; ; desde += 1000) {
    let q = db.from(tabla).select(cols).order("id").range(desde, desde + 999); if (filtro) q = filtro(q);
    const { data, error } = await q; if (error) throw new Error(`${tabla}: ${error.message}`);
    out.push(...(data || [])); if (!data || data.length < 1000) return out;
  }
}
const igual = (local: any, m: any) => Object.keys(m).every((k) => String(local?.[k] ?? "") === String(m[k] ?? ""));
async function enParalelo<T>(xs: T[], n: number, f: (x: T) => Promise<void>) { for (let i = 0; i < xs.length; i += n) await Promise.all(xs.slice(i, i + n).map(f)); }
const PAGS_POR_LLAMADA = Number(Deno.env.get("ZOHO_PAGS_POR_LLAMADA")) || 4;   // 800 registros por invocación: cabe holgado en el límite de CPU/tiempo de la Edge Function

// Sincronización por tramos de páginas de Zoho. Solo escribe lo nuevo (inserción en bloque) y lo que cambió (en paralelo);
// lo idéntico no se toca. Devuelve `siguiente` (página por la que seguir) hasta que no queda nada: la pantalla repite la llamada.
async function syncTramo(db: any, actor: string, o: { sistema: string; entidad: string; app: "books" | "inventory"; ruta: string; clave: string; params: Record<string, string>;
  tabla: string; idZ: string; alt: string; mapear: (x: any) => any; alInsertar?: Record<string, unknown>; conFecha?: boolean }, desde?: string, pagina = 1) {
  return conLog(db, o.sistema, o.entidad, "entrada", actor, async (log) => {
    const lista: any[] = []; let siguiente: number | null = null;
    for (let page = pagina; page < pagina + PAGS_POR_LLAMADA; page++) {
      const j = await zoho(db, o.app, o.ruta, {}, { ...o.params, page: String(page), per_page: "200" });
      lista.push(...(j[o.clave] || []));
      if (!j.page_context?.has_more_page) { siguiente = null; break; }
      siguiente = page + 1;
    }
    const filas = recientes(lista, desde).map(o.mapear);
    log.leidos = filas.length; log.detalle.push(`páginas ${pagina}–${siguiente ? siguiente - 1 : "fin"} de Zoho`);
    const locales = await todos(db, o.tabla, "*");
    const porZ = new Map(locales.filter((x: any) => x[o.idZ]).map((x: any) => [String(x[o.idZ]), x]));
    const porAlt = new Map(locales.map((x: any) => [String(x[o.alt]), x]));
    const nuevos: any[] = [], cambios: { id: string; m: any }[] = [];
    for (const m of filas) {
      const ex: any = porZ.get(String(m[o.idZ])) || porAlt.get(String(m[o.alt]));
      if (!ex) nuevos.push({ ...m, ...(o.alInsertar || {}) });
      else if (!igual(ex, m)) cambios.push({ id: ex.id, m: o.conFecha ? { ...m, updated_at: new Date().toISOString() } : m });
    }
    // Inserción en bloque, agrupando por conjunto de columnas (PostgREST rellena con NULL las que faltan en un lote mixto)
    const grupos = new Map<string, any[]>(); for (const n of nuevos) { const k = Object.keys(n).sort().join(","); grupos.set(k, [...(grupos.get(k) || []), n]); }
    for (const g of grupos.values()) for (let i = 0; i < g.length; i += 200) {
      const lote = g.slice(i, i + 200); const { error } = await db.from(o.tabla).insert(lote);
      if (!error) { log.creados += lote.length; continue; }
      for (const n of lote) { const { error: e1 } = await db.from(o.tabla).insert(n); if (e1) { log.errores++; log.detalle.push(`${n[o.alt]}: ${e1.message}`); } else log.creados++; }
    }
    await enParalelo(cambios, 8, async (c) => {
      const { error } = await db.from(o.tabla).update(c.m).eq("id", c.id);
      if (error) { log.errores++; log.detalle.push(`${c.m[o.alt]}: ${error.message}`); } else log.actualizados++;
    });
    log.siguiente = siguiente;
  });
}
async function syncClientes(db: any, actor: string, desde?: string, pagina = 1) {
  const cfg = await cfgDe(db, "zoho_books");
  return syncTramo(db, actor, { sistema: "zoho_books", entidad: "clientes", app: "books", ruta: "/contacts", clave: "contacts", params: { contact_type: "customer" },
    tabla: "clientes", idZ: "zoho_contact_id", alt: "codigo", mapear: (c) => mapCliente(c, cfg), alInsertar: { geo_estado: "pendiente" }, conFecha: true }, desde, pagina);
}
async function syncArticulos(db: any, actor: string, desde?: string, pagina = 1) {
  return syncTramo(db, actor, { sistema: SIS(), entidad: "articulos", app: PROD(), ruta: "/items", clave: "items", params: { filter_by: "Status.Active" },
    tabla: "articulos", idZ: "zoho_item_id", alt: "sku", mapear: (i) => {
      const m: any = mapArticulo(i);
      for (const k of ["peso_kg", "volumen_m3", "codigo_barras", "categoria"]) if (m[k] == null) delete m[k];   // no borrar datos logísticos cargados a mano
      return m;
    } }, desde, pagina);
}
// Direcciones: el listado de contactos de Zoho no las incluye, hay que pedir el detalle de cada uno. Por lotes (40 por llamada,
// 4 en paralelo) para respetar el límite de ~100 peticiones/min; la pantalla repite hasta que `quedan` = 0. Reanudable: solo toma
// clientes sin dirección y sin la marca geo_estado = 'sin_direccion' (Zoho tampoco la tiene en el detalle).
async function completarDirecciones(db: any, actor: string, lote = 40) {
  return conLog(db, "zoho_books", "direcciones", "entrada", actor, async (log) => {
    const base = () => db.from("clientes").select("id,codigo,nombre,zoho_contact_id,telefono", { count: "exact" }).not("zoho_contact_id", "is", null)
      .is("direccion", null).or("geo_estado.is.null,geo_estado.neq.sin_direccion");
    const { data: pend, error } = await base().order("codigo").limit(Math.min(Math.max(lote, 1), 80));
    if (error) throw new Error(error.message);
    log.leidos = (pend || []).length; log.sin_direccion = 0; let limite = "";
    await enParalelo(pend || [], 4, async (c: any) => {
      if (limite) return;
      try {
        const det = (await zoho(db, "books", `/contacts/${c.zoho_contact_id}`)).contact || {};
        const dir = direccionDeContacto(det);
        const tel = c.telefono || (String(det.mobile || det.phone || (det.contact_persons || []).map((p: any) => p.mobile || p.phone).find(Boolean) || "").replace(/[<>]/g, "").trim() || null);
        const patch: any = dir ? { direccion: dir, geo_estado: "pendiente" } : { geo_estado: "sin_direccion" };
        if (tel && !c.telefono) patch.telefono = tel;
        const { error: ue } = await db.from("clientes").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", c.id);
        if (ue) { log.errores++; log.detalle.push(`${c.codigo}: ${ue.message}`); } else if (dir) log.actualizados++; else { log.sin_direccion++; log.detalle.push(`${c.nombre}: Zoho no tiene dirección`); }
      } catch (e) {
        const m = (e as any)?.message || String(e); log.errores++; log.detalle.push(`${c.codigo}: ${m}`);
        if (/l[ií]mite|limit|exceed/i.test(m)) limite = m;          // límite diario/por minuto de la API: parar el lote
      }
    });
    const { count, data: resto } = await base().limit(1);
    log.quedan = count ?? (resto || []).length;   // sin conteo exacto, al menos indica si queda alguno log.limite = limite || null;
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
    const [clientes, arts, existentes] = await Promise.all([      // lectura completa: con más de 1000 clientes la consulta simple se cortaba
      todos(db, "clientes", "id,zoho_contact_id", (q) => q.not("zoho_contact_id", "is", null)), todos(db, "articulos", "id,sku,peso_kg,volumen_m3,unidades_por_caja"),
      todos(db, "pedidos", "id,zoho_salesorder_id,estado", (q) => q.not("zoho_salesorder_id", "is", null))]);
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
      // ZOH-001: cabecera + líneas en una transacción (RPC). Si algo falla, la orden queda como estaba (o no se crea).
      const { data: g, error: ge } = await db.rpc("zoho_guardar_pedido", { pedido: m.pedido, lineas: m.lineas.map(({ conocido: _c, ...l }) => l) });
      if (ge) { log.errores++; log.detalle.push(`${m.pedido.numero_so}: ${ge.message} (no se modificó nada)`); continue; }
      g?.nuevo ? log.creados++ : log.actualizados++;
    }
  });
}
// ZOH-002: tras un efecto en Zoho, cada escritura local se comprueba. Si falla, se informa error (no éxito); el reintento
// reconcilia con lo que ya existe en Zoho (paquete por package_number, comentario por "DESPACHO DGP <número>") y no duplica.
async function guardarLocal(q: PromiseLike<{ error: any }>, que: string) {
  const { error } = await q;
  if (error) throw new Error(`Zoho registró ${que}, pero no se pudo guardar en DGP (${error.message}). Reintenta: no se duplicará en Zoho.`);
}
async function registrarEnvio(db: any, actor: string, paqueteId: string) {
  const { data: q } = await db.from("paquetes").select("*").eq("id", paqueteId).single();
  if (!q) throw new Error("Paquete no encontrado");
  if (q.books_shipment_id && !String(q.books_shipment_id).startsWith("SIM-")) return { ok: true, ya: true, shipment_id: q.books_shipment_id };
  const { data: p } = await db.from("pedidos").select("zoho_salesorder_id,numero_so").eq("id", q.pedido_id).single();
  if (!p?.zoho_salesorder_id) throw new Error(`El pedido ${p?.numero_so || ""} no viene de Zoho (sin salesorder_id)`);
  // FUN-05: solo una ejecución a la vez por paquete. Reclamo atómico en la base; otro intento simultáneo no llama a Zoho.
  const { data: reclamado, error: re } = await db.rpc("zoho_reclamar_paquete", { pid: q.id });
  if (re) throw new Error(`No se pudo reservar el paquete para Zoho: ${re.message}`);
  if (!reclamado) {
    const { data: ahora } = await db.from("paquetes").select("books_shipment_id").eq("id", q.id).single();
    if (ahora?.books_shipment_id && !String(ahora.books_shipment_id).startsWith("SIM-")) return { ok: true, ya: true, shipment_id: ahora.books_shipment_id };
    return { ok: false, en_curso: true, error: "Este paquete ya se está registrando en Zoho. Espera unos segundos y actualiza." };
  }
  try { return await registrarEnvioReclamado(db, actor, q, p); }
  finally { await db.from("paquetes").update({ zoho_bloqueo_at: null }).eq("id", q.id); }
}
async function registrarEnvioReclamado(db: any, actor: string, q: any, p: any) {
  if (PROD() === "books") return conLog(db, "zoho_books", "envios", "salida", actor, async (log) => {
    log.leidos = 1;
    const so = (await zoho(db, "books", `/salesorders/${p.zoho_salesorder_id}`)).salesorder;
    const { data: ruta } = q.ruta_id ? await db.from("rutas").select("codigo,conductor").eq("id", q.ruta_id).maybeSingle() : { data: null };
    const texto = comentarioEnvio(so, q, { conductor: ruta?.conductor, ruta: ruta?.codigo || q.color_nombre, actor });
    // Reconciliación Books: si un intento anterior ya dejó el comentario de este paquete, se reutiliza
    const previos = (await zoho(db, "books", `/salesorders/${p.zoho_salesorder_id}/comments`)).comments || [];
    const ya = buscarComentarioDespacho(previos, q.numero);
    let cid = ya ? String(ya.comment_id) : "";
    if (ya) log.detalle.push(`${q.numero}: comentario ya existía en Zoho (${cid}), reutilizado`);
    else { const c = await zoho(db, "books", `/salesorders/${p.zoho_salesorder_id}/comments`, { method: "POST", body: JSON.stringify({ description: texto }) }); cid = String(c.comment?.comment_id || c.comment_id || "ok"); }
    // Opcional: marcar un campo personalizado de la orden (config.campo_despacho_id = customfield_id; valor = config.valor_despacho o "Despachado")
    const cfg = await cfgDe(db, "zoho_books");
    if (cfg.campo_despacho_id) {
      try { await zoho(db, "books", `/salesorder/${p.zoho_salesorder_id}/customfields`, { method: "PUT", body: JSON.stringify([{ customfield_id: String(cfg.campo_despacho_id), value: cfg.valor_despacho || "Despachado" }]) }); }
      catch (e) { log.errores++; log.detalle.push(`campo personalizado no actualizado: ${(e as any).message}`); }
    }
    const ref = `BOOKS-SO-${p.zoho_salesorder_id}-C${cid}`;
    await guardarLocal(db.from("paquetes").update({ books_shipment_id: ref, books_registrado_at: new Date().toISOString(), books_registrado_por: actor, books_error: null }).eq("id", q.id), "el comentario de despacho");
    log.creados = 1; log.detalle.push(`${q.numero} → comentario de despacho en ${so.salesorder_number}`);
  });
  return conLog(db, "zoho_inventory", "envios", "salida", actor, async (log) => {
    log.leidos = 1;
    const so = (await zoho(db, "inventory", `/salesorders/${p.zoho_salesorder_id}`)).salesorder;
    let pkgId = q.zoho_package_id; let sid = "";
    // Reconciliación: antes de crear nada se mira qué existe ya en Zoho para esta orden. Se reutiliza el paquete (mismo id o
    // mismo package_number) y su envío si lo tiene: un intento anterior pudo crearlos y perder la respuesta o el guardado local.
    const previos = (await zoho(db, "inventory", "/packages", {}, { salesorder_id: String(p.zoho_salesorder_id) })).packages || [];
    const ya = buscarPaquete(previos, pkgId, q.numero);
    if (ya) {
      sid = String(ya.shipment_id || "");
      if (!pkgId) { pkgId = String(ya.package_id); await guardarLocal(db.from("paquetes").update({ zoho_package_id: pkgId }).eq("id", q.id), "el paquete"); log.detalle.push(`${q.numero}: paquete ya existía en Zoho (${pkgId}), reutilizado`); }
      if (sid) log.detalle.push(`${q.numero}: envío ya existía en Zoho (${sid}), reutilizado`);
    }
    if (!pkgId) { const pk = await zoho(db, "inventory", "/packages", { method: "POST", body: JSON.stringify(paqueteZoho(so, q)) }, { salesorder_id: String(p.zoho_salesorder_id) }); pkgId = String(pk.package.package_id); await guardarLocal(db.from("paquetes").update({ zoho_package_id: pkgId }).eq("id", q.id), `el paquete ${pkgId}`); }
    if (!sid) {
      const sh = await zoho(db, "inventory", "/shipmentorders", { method: "POST", body: JSON.stringify({ shipment_number: `ENV-${q.numero}`, date: hoyPanama(), delivery_method: "Flota DGP", tracking_number: q.numero, notes: `Ruta ${q.color_nombre || ""}` }) }, { package_ids: pkgId, salesorder_id: String(p.zoho_salesorder_id) });
      sid = String(sh.shipmentorder?.shipment_id || sh.shipment_order?.shipment_id || "");
    }
    await guardarLocal(db.from("paquetes").update({ books_shipment_id: sid, books_registrado_at: new Date().toISOString(), books_registrado_por: actor, books_error: null }).eq("id", q.id), `el envío ${sid}`);
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
    if (b.accion === "sync_clientes") return json(await syncClientes(db, actor, b.desde, Math.max(1, Number(b.pagina) || 1)));
    if (b.accion === "sync_articulos") return json(await syncArticulos(db, actor, b.desde, Math.max(1, Number(b.pagina) || 1)));
    if (b.accion === "completar_direcciones") return json(await completarDirecciones(db, actor, Number(b.lote) || 40));
    if (b.accion === "sync_pedidos") return json(await syncPedidos(db, actor, b.desde));
    if (b.accion === "registrar_envio") { const r: any = await registrarEnvio(db, actor, b.paquete_id); return json(r, r.en_curso ? 409 : 200); }
    return json({ error: "Acción desconocida" }, 400);
  } catch (e) {
    if (b.accion === "registrar_envio" && b.paquete_id) await db.from("paquetes").update({ books_error: (e as any).message }).eq("id", b.paquete_id);
    return json({ error: (e as any)?.message || String(e) }, 500);
  }
});
