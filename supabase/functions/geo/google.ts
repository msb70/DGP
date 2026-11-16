// DGP · llamadas a Google Maps Platform, compartidas por las funciones "geo" y "zoho".
// 1) Places API (New) Text Search con "nombre + dirección" dentro de Panamá (encuentra el negocio aunque la dirección
//    sea descriptiva). 2) Si no aparece o solo cae en el barrio, Geocoding API con la dirección. 3) Si nada, null.
import { clasificarGeocoding, clasificarPlace, consultaPlaces, DENTRO_PANAMA } from "./lib.ts";

const env = (k: string, d = "") => Deno.env.get(k) || d;
export const KEY = () => env("GOOGLE_MAPS_API_KEY");
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
// Coordenada de un punto de entrega. Devuelve {lat,lng,estado,fuente,detalle} o null (no encontrada). Lanza ante error de clave/cuota.
export async function resolver(nombre: string, direccion: string) {
  let res: any = null;
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
export const esCorte = (m: string) => /40[013]|429|REQUEST_DENIED|OVER_QUERY_LIMIT|OVER_DAILY_LIMIT|API key|billing/i.test(m);
// Patch para la fila geocodificada (clientes o cliente_direcciones)
export const patchGeo = (res: any) => res
  ? { lat: res.lat, lng: res.lng, geo_estado: res.estado, geo_fuente: res.fuente, geo_detalle: res.detalle }
  : { geo_estado: "no_encontrada", geo_fuente: "google", geo_detalle: null };
