// DGP · Edge Function "geo": coordenadas de clientes con Google Maps Platform.
// Acciones (POST {accion}):
//   estado                  → hay clave, prueba una búsqueda y cuenta pendientes                  (ver.integraciones)
//   geocodificar {lote?}    → primero las direcciones de entrega de los pedidos (cliente_direcciones), después la dirección
//                             principal de los clientes; busca y guarda las coordenadas   (integraciones.gestionar o catalogo.editar)
//     Con Google: 1) Places API (New) Text Search con "nombre + dirección" dentro de Panamá → encuentra el negocio aunque la dirección
//        sea descriptiva ("frente a la Terpel"). 2) Si no aparece, Geocoding API con la dirección. 3) Si nada, 'no_encontrada'.
//     geo_estado: automatica (negocio o dirección exacta) · aproximada (solo barrio/calle) · no_encontrada.
//     geo_fuente: google_places | google_geocoding · geo_detalle: lo que Google reconoció (para revisar a mano).
// Proveedor: GOOGLE_MAPS_API_KEY (Places API (New) + Geocoding API; de pago con cupo gratis) o, si no existe,
//            APPS_SCRIPT_GEO_URL + APPS_SCRIPT_GEO_CLAVE (aplicación web gratuita de tools/apps-script-geo).
// Despliegue: supabase functions deploy geo   (verify_jwt activado)
import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { esCorte, patchGeo, probar, proveedor, resolver } from "./google.ts";

const env = (k: string, d = "") => Deno.env.get(k) || d;
const CORS = { "Access-Control-Allow-Origin": env("ALLOWED_ORIGINS", "*").split(",")[0].trim(), "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });
const PEND = "geo_estado.is.null,geo_estado.not.in.(sin_direccion,no_encontrada)";

// Un lote: primero las direcciones de entrega de los pedidos (las de más pedidos y más recientes primero); cuando no
// queda ninguna, la dirección principal de los clientes. La coordenada se comparte entre cliente y direcciones con el mismo
// texto (triggers de 2026-11-16b): cada dirección se consulta una sola vez.
async function geocodificar(db: any, actor: string, lote: number) {
  const n = Math.min(Math.max(lote, 1), 60);
  const baseCli = () => db.from("clientes").select("id,codigo,nombre,direccion", { count: "exact" }).not("direccion", "is", null).is("lat", null).or(PEND);
  const baseDir = () => db.from("cliente_direcciones").select("id,clave,atencion,direccion,cliente_id", { count: "exact" }).is("lat", null).or(PEND);
  let tabla = "cliente_direcciones";
  let { data: pend, error } = await baseDir().order("pedidos", { ascending: false }).order("ultimo_pedido_at", { ascending: false, nullsFirst: false }).limit(n);
  if (error) throw new Error(error.message);
  if ((pend || []).length) {
    const ids = [...new Set((pend || []).map((d: any) => d.cliente_id))];
    const { data: cs } = ids.length ? await db.from("clientes").select("id,codigo,nombre").in("id", ids) : { data: [] };
    const porId = new Map((cs || []).map((c: any) => [c.id, c]));
    for (const d of pend || []) d.clientes = porId.get(d.cliente_id) || null;
  } else {
    tabla = "clientes";
    ({ data: pend, error } = await baseCli().order("codigo").limit(n));
    if (error) throw new Error(error.message);
  }
  const t = { leidos: (pend || []).length, precisas: 0, aproximadas: 0, no_encontradas: 0, errores: 0, detalle: [] as string[] };
  let corte = "";
  const una = async (c: any) => {
    if (corte) return;
    const cod = c.codigo || c.clientes?.codigo || c.clave;
    try {
      const res = await resolver(c.atencion || c.nombre || c.clientes?.nombre || "", c.direccion);
      const extra = tabla === "cliente_direcciones" ? { geo_at: new Date().toISOString() } : {};
      const { error: ue } = await db.from(tabla).update({ ...patchGeo(res), ...extra, updated_at: new Date().toISOString() }).eq("id", c.id);
      if (ue) { t.errores++; t.detalle.push(`${cod}: ${ue.message}`); return; }
      if (!res) t.no_encontradas++; else if (res.estado === "automatica") t.precisas++; else t.aproximadas++;
    } catch (e) {
      const m = (e as any)?.message || String(e); t.errores++; t.detalle.push(`${cod}: ${m}`);
      if (esCorte(m)) corte = m;   // clave, facturación o cuota: parar
    }
  };
  for (let i = 0; i < (pend || []).length; i += 8) await Promise.all(pend.slice(i, i + 8).map(una));
  const quedanCli = (await baseCli().limit(1)).count ?? 0, quedanDir = (await baseDir().limit(1)).count ?? 0;
  await db.from("auditoria").insert({ entidad: tabla, accion: "geocodificacion", detalle: `Coordenadas ${proveedor()} (${tabla === "clientes" ? "clientes" : "direcciones de entrega"}): ${t.precisas} precisas, ${t.aproximadas} aproximadas, ${t.no_encontradas} no encontradas, ${t.errores} con error`, actor, automatico: false });
  return { ok: true, ...t, tabla, detalle: t.detalle.slice(0, 20), quedan: quedanCli + quedanDir, quedan_clientes: quedanCli, quedan_direcciones: quedanDir, corte: corte || null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const yo = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), { global: { headers: { Authorization: req.headers.get("authorization") || "" } }, auth: { persistSession: false } });
  const { data: perfil } = await yo.rpc("mi_perfil");
  if (!perfil || !perfil.activo) return json({ error: "Sin sesión" }, 401);
  const p: string[] = perfil.permisos || []; const actor = perfil.nombre || perfil.email;
  let b: any; try { b = await req.json(); } catch { return json({ error: "Cuerpo inválido" }, 400); }
  const necesita = b.accion === "estado" ? ["ver.integraciones", "integraciones.gestionar", "catalogo.editar"] : ["integraciones.gestionar", "catalogo.editar"];
  if (!necesita.some((x) => p.includes(x))) return json({ error: "Tu rol no tiene permiso para esta acción" }, 403);
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  try {
    if (b.accion === "estado") {
      const cuenta = async (f: (q: any) => any) => (await f(db.from("clientes").select("id", { count: "exact", head: true }))).count ?? null;
      const out: any = { clave: !!proveedor(), proveedor: proveedor(),
        pendientes: await cuenta((q) => q.not("direccion", "is", null).is("lat", null).or("geo_estado.is.null,geo_estado.not.in.(sin_direccion,no_encontrada)")),
        precisas: await cuenta((q) => q.eq("geo_estado", "automatica").not("lat", "is", null)), aproximadas: await cuenta((q) => q.eq("geo_estado", "aproximada")),
        no_encontradas: await cuenta((q) => q.eq("geo_estado", "no_encontrada")), validadas: await cuenta((q) => q.eq("geo_estado", "validada")) };
      const dirs = async (f: (q: any) => any) => (await f(db.from("cliente_direcciones").select("id", { count: "exact", head: true }))).count ?? null;
      out.direcciones = { total: await dirs((q) => q), pendientes: await dirs((q) => q.is("lat", null).or(PEND)), aproximadas: await dirs((q) => q.eq("geo_estado", "aproximada")), no_encontradas: await dirs((q) => q.eq("geo_estado", "no_encontrada")) };
      out.pendientes = (out.pendientes || 0) + (out.direcciones.pendientes || 0);
      if (out.clave) { try { out.prueba = (await probar()) ? "ok" : "sin resultado"; } catch (e) { out.prueba = (e as any).message; } }
      return json(out);
    }
    if (!proveedor()) return json({ error: "Sin proveedor de coordenadas: falta GOOGLE_MAPS_API_KEY o APPS_SCRIPT_GEO_URL + APPS_SCRIPT_GEO_CLAVE (Supabase → Edge Functions → Secrets)." }, 400);
    if (b.accion === "geocodificar") return json(await geocodificar(db, actor, Number(b.lote) || 40));
    if (b.accion === "reintentar_no_encontradas") {   // tras corregir direcciones en Zoho o a mano
      const { error } = await db.from("clientes").update({ geo_estado: "pendiente" }).eq("geo_estado", "no_encontrada"); if (error) throw error;
      const { error: e2 } = await db.from("cliente_direcciones").update({ geo_estado: "pendiente" }).eq("geo_estado", "no_encontrada"); if (e2) throw e2;
      return json({ ok: true });
    }
    return json({ error: "Acción desconocida" }, 400);
  } catch (e) { return json({ error: (e as any)?.message || String(e) }, 500); }
});
