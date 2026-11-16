// DGP · coordenadas de direcciones, compartido por las funciones "geo" y "zoho". Dos proveedores:
// · google (secreto GOOGLE_MAPS_API_KEY, de pago con cupo gratis): 1) Places API (New) Text Search con "nombre + dirección"
//   (encuentra el negocio aunque la dirección sea descriptiva). 2) Si no aparece o solo cae en el barrio, Geocoding API.
// · apps_script (secretos APPS_SCRIPT_GEO_URL + APPS_SCRIPT_GEO_CLAVE, gratis, ~1.000/día con Gmail): aplicación web de
//   tools/apps-script-geo con Maps.newGeocoder. Solo dirección; si no la encuentra, prueba "nombre, dirección".
// Manda la clave de Google si existe; si no, Apps Script. Sin ninguno, no se geocodifica.
import { clasificarGeocoding, clasificarPlace, consultaPlaces, DENTRO_PANAMA } from "./lib.ts";

const env = (k: string, d = "") => Deno.env.get(k) || d;
export const KEY = () => env("GOOGLE_MAPS_API_KEY");
const AS_URL = () => env("APPS_SCRIPT_GEO_URL"), AS_CLAVE = () => env("APPS_SCRIPT_GEO_CLAVE");
export const proveedor = (): "google" | "apps_script" | null => KEY() ? "google" : AS_URL() && AS_CLAVE() ? "apps_script" : null;
const PLACES = () => env("GOOGLE_PLACES_URL", "https://places.googleapis.com/v1/places:searchText");          // *_URL solo para pruebas
const GEOCODE = () => env("GOOGLE_GEOCODE_URL", "https://maps.googleapis.com/maps/api/geocode/json");

export async function places(q: string) {
  const r = await fetch(PLACES(), { method: "POST", headers: { "content-type": "application/json", "X-Goog-Api-Key": KEY(), "X-Goog-FieldMask": "places.id,places.location,places.formattedAddress,places.displayName,places.types" },
    body: JSON.stringify({ textQuery: q, regionCode: "PA", languageCode: "es", pageSize: 1, locationRestriction: { rectangle: DENTRO_PANAMA } }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google Places ${r.status}: ${j.error?.message || ""}`.trim());
  return (j.places || [])[0] || null;
}
export async function geocoding(q: string) {
  const u = new URL(GEOCODE()); u.search = new URLSearchParams({ address: q, components: "country:PA", language: "es", key: KEY() }).toString();
  const r = await fetch(u); const j = await r.json().catch(() => ({}));
  if (j.status === "ZERO_RESULTS") return null;
  if (!r.ok || j.status !== "OK") throw new Error(`Google Geocoding ${j.status || r.status}: ${j.error_message || ""}`.trim());
  return j.results[0];
}
// Apps Script publicado como aplicación web: GET ?clave=&q= → mismo formato que la Geocoding API (la URL /exec redirige a
// googleusercontent.com; fetch sigue la redirección).
export async function appsScript(q: string) {
  const u = new URL(AS_URL()); u.searchParams.set("q", q.slice(0, 300)); u.searchParams.set("clave", AS_CLAVE());
  const r = await fetch(u, { redirect: "follow" }); const t = await r.text();
  let j: any; try { j = JSON.parse(t); } catch { throw new Error(`Apps Script ${r.status}: la respuesta no es JSON (¿publicada como aplicación web con acceso «Cualquier usuario»?)`); }
  if (j.status === "ZERO_RESULTS") return null;
  if (j.status !== "OK") throw new Error(`Apps Script ${j.status}: ${j.error_message || ""}`.trim());
  return (j.results || [])[0] || null;
}
// Prueba de conexión para la pantalla de Integraciones
export async function probar() {
  return proveedor() === "apps_script" ? await appsScript("Vía España, Panamá") : await geocoding("Vía España, Panamá");
}
// Coordenada de un punto de entrega. Devuelve {lat,lng,estado,fuente,detalle} o null (no encontrada). Lanza ante error de clave/cuota.
export async function resolver(nombre: string, direccion: string) {
  let res: any = null;
  if (proveedor() === "apps_script") {
    const g = await appsScript(`${direccion}, Panamá`);
    res = g ? clasificarGeocoding(g, "apps_script") : null;
    if (!res && nombre) { const g2 = await appsScript(consultaPlaces(nombre, direccion)); res = g2 ? clasificarGeocoding(g2, "apps_script") : null; }
    return res;
  }
  const p = await places(consultaPlaces(nombre, direccion));
  if (p) res = clasificarPlace(p);
  if (!res || res.estado === "aproximada") {
    const g = await geocoding(`${direccion}, Panamá`);
    const rg = g ? clasificarGeocoding(g) : null;
    if (rg && (!res || rg.estado === "automatica")) res = rg;
  }
  return res;
}
// Errores que significan "no sigas": clave inválida, facturación o cuota
export const esCorte = (m: string) => /40[013]|429|REQUEST_DENIED|OVER_QUERY_LIMIT|OVER_DAILY_LIMIT|API key|billing|Apps Script (CONFIG|UNKNOWN_ERROR)|no es JSON/i.test(m);
// Patch para la fila geocodificada (clientes o cliente_direcciones)
export const patchGeo = (res: any) => res
  ? { lat: res.lat, lng: res.lng, geo_estado: res.estado, geo_fuente: res.fuente, geo_detalle: res.detalle }
  : { geo_estado: "no_encontrada", geo_fuente: proveedor() || "google", geo_detalle: null };
