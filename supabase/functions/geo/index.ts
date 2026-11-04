// DGP · Edge Function "geo": coordenadas de clientes con Google Maps Platform.
// Acciones (POST {accion}):
//   estado                  → hay clave, prueba una búsqueda y cuenta pendientes                  (ver.integraciones)
//   geocodificar {lote?}    → toma clientes con dirección y sin coordenada, los busca y guarda      (integraciones.gestionar o catalogo.editar)
//     1) Places API (New) Text Search con "nombre + dirección" dentro de Panamá → encuentra el negocio aunque la dirección
//        sea descriptiva ("frente a la Terpel"). 2) Si no aparece, Geocoding API con la dirección. 3) Si nada, 'no_encontrada'.
//     geo_estado: automatica (negocio o dirección exacta) · aproximada (solo barrio/calle) · no_encontrada.
//     geo_fuente: google_places | google_geocoding · geo_detalle: lo que Google reconoció (para revisar a mano).
// Secreto: GOOGLE_MAPS_API_KEY (APIs habilitadas: Places API (New) y Geocoding API; restringir la clave a esas dos).
// Despliegue: supabase functions deploy geo   (verify_jwt activado)
import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { clasificarGeocoding, clasificarPlace, consultaPlaces, DENTRO_PANAMA } from "./lib.ts";

const env = (k: string, d = "") => Deno.env.get(k) || d;
const CORS = { "Access-Control-Allow-Origin": env("ALLOWED_ORIGINS", "*").split(",")[0].trim(), "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });
const KEY = () => env("GOOGLE_MAPS_API_KEY");
const PLACES = () => env("GOOGLE_PLACES_URL", "https://places.googleapis.com/v1/places:searchText");          // *_URL solo para pruebas
const GEOCODE = () => env("GOOGLE_GEOCODE_URL", "https://maps.googleapis.com/maps/api/geocode/json");

async function places(q: string) {
  const r = await fetch(PLACES(), { method: "POST", headers: { "content-type": "application/json", "X-Goog-Api-Key": KEY(), "X-Goog-FieldMask": "places.id,places.location,places.formattedAddress,places.displayName,places.types" },
    body: JSON.stringify({ textQuery: q, regionCode: "PA", languageCode: "es", pageSize: 1, locationRestriction: { rectangle: DENTRO_PANAMA } }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google Places ${r.status}: ${j.error?.message || ""}`.trim());
  return (j.places || [])[0] || null;
}
async function geocoding(q: string) {
  const u = new URL(GEOCODE()); u.search = new URLSearchParams({ address: q, components: "country:PA", language: "es", key: KEY() }).toString();
  const r = await fetch(u); const j = await r.json().catch(() => ({}));
  if (j.status === "ZERO_RESULTS") return null;
  if (!r.ok || j.status !== "OK") throw new Error(`Google Geocoding ${j.status || r.status}: ${j.error_message || ""}`.trim());
  return j.results[0];
}

async function geocodificar(db: any, actor: string, lote: number) {
  const base = () => db.from("clientes").select("id,codigo,nombre,direccion", { count: "exact" }).not("direccion", "is", null).is("lat", null)
    .or("geo_estado.is.null,geo_estado.not.in.(sin_direccion,no_encontrada)");
  const { data: pend, error } = await base().order("codigo").limit(Math.min(Math.max(lote, 1), 60));
  if (error) throw new Error(error.message);
  const t = { leidos: (pend || []).length, precisas: 0, aproximadas: 0, no_encontradas: 0, errores: 0, detalle: [] as string[] };
  let corte = "";
  const una = async (c: any) => {
    if (corte) return;
    try {
      let res: any = null;
      const p = await places(consultaPlaces(c.nombre, c.direccion));
      if (p) res = clasificarPlace(p);
      if (!res || res.estado === "aproximada") {                 // el negocio no aparece o solo cae en el barrio: probar la dirección
        const g = await geocoding(`${c.direccion}, Panamá`);
        const rg = g ? clasificarGeocoding(g) : null;
        if (rg && (!res || rg.estado === "automatica")) res = rg;
      }
      const patch: any = res ? { lat: res.lat, lng: res.lng, geo_estado: res.estado, geo_fuente: res.fuente, geo_detalle: res.detalle } : { geo_estado: "no_encontrada", geo_fuente: "google", geo_detalle: null };
      const { error: ue } = await db.from("clientes").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", c.id);
      if (ue) { t.errores++; t.detalle.push(`${c.codigo}: ${ue.message}`); return; }
      if (!res) t.no_encontradas++; else if (res.estado === "automatica") t.precisas++; else t.aproximadas++;
    } catch (e) {
      const m = (e as any)?.message || String(e); t.errores++; t.detalle.push(`${c.codigo}: ${m}`);
      if (/40[013]|429|REQUEST_DENIED|OVER_QUERY_LIMIT|OVER_DAILY_LIMIT|API key|billing/i.test(m)) corte = m;   // clave, facturación o cuota: parar
    }
  };
  for (let i = 0; i < (pend || []).length; i += 8) await Promise.all(pend.slice(i, i + 8).map(una));
  const { count, data: resto } = await base().limit(1);
  await db.from("auditoria").insert({ entidad: "clientes", accion: "geocodificacion", detalle: `Google Maps: ${t.precisas} precisas, ${t.aproximadas} aproximadas, ${t.no_encontradas} no encontradas, ${t.errores} con error`, actor, automatico: false });
  return { ok: true, ...t, detalle: t.detalle.slice(0, 20), quedan: count ?? (resto || []).length, corte: corte || null };
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
      const out: any = { clave: !!KEY(),
        pendientes: await cuenta((q) => q.not("direccion", "is", null).is("lat", null).or("geo_estado.is.null,geo_estado.not.in.(sin_direccion,no_encontrada)")),
        precisas: await cuenta((q) => q.eq("geo_estado", "automatica").not("lat", "is", null)), aproximadas: await cuenta((q) => q.eq("geo_estado", "aproximada")),
        no_encontradas: await cuenta((q) => q.eq("geo_estado", "no_encontrada")), validadas: await cuenta((q) => q.eq("geo_estado", "validada")) };
      if (out.clave) { try { out.prueba = (await geocoding("Vía España, Panamá")) ? "ok" : "sin resultado"; } catch (e) { out.prueba = (e as any).message; } }
      return json(out);
    }
    if (!KEY()) return json({ error: "Falta el secreto GOOGLE_MAPS_API_KEY en la función geo (Supabase → Edge Functions → Secrets)." }, 400);
    if (b.accion === "geocodificar") return json(await geocodificar(db, actor, Number(b.lote) || 40));
    if (b.accion === "reintentar_no_encontradas") {   // tras corregir direcciones en Zoho o a mano
      const { error } = await db.from("clientes").update({ geo_estado: "pendiente" }).eq("geo_estado", "no_encontrada"); if (error) throw error;
      return json({ ok: true });
    }
    return json({ error: "Acción desconocida" }, 400);
  } catch (e) { return json({ error: (e as any)?.message || String(e) }, 500); }
});
