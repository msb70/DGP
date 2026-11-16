// DGP · geo: funciones puras (probadas con deno test en tests/edge).
export const DENTRO_PANAMA = { low: { latitude: 7.0, longitude: -83.1 }, high: { latitude: 9.7, longitude: -77.1 } };
const limpio = (s: unknown) => (s == null ? "" : String(s)).replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
const enPanama = (lat: number, lng: number) => lat >= 7 && lat <= 9.7 && lng >= -83.1 && lng <= -77.1;
// Tipos de Google que indican una zona y no un punto de entrega
const ZONA = new Set(["locality", "sublocality", "sublocality_level_1", "neighborhood", "administrative_area_level_1", "administrative_area_level_2", "administrative_area_level_3", "political", "country", "postal_code", "colloquial_area", "route"]);

// "Nombre, dirección" quitando ruido que confunde la búsqueda (horarios, "(Colaborador)", teléfonos)
export function consultaPlaces(nombre: string, direccion: string) {
  const n = limpio(nombre).replace(/\((colaborador|cliente)[^)]*\)/gi, "").trim();
  const d = limpio(direccion).replace(/\bH\.?\s?E\.?\s*:?[^,]*/gi, "").replace(/\+?\d[\d\s-]{6,}/g, "").replace(/,\s*,/g, ",").trim();
  const dir = n && d.toLowerCase().startsWith(n.toLowerCase()) ? d : [n, d].filter(Boolean).join(", ");
  return `${dir}, Panamá`.slice(0, 300);
}
export function clasificarPlace(p: any) {
  const lat = Number(p?.location?.latitude), lng = Number(p?.location?.longitude);
  if (!isFinite(lat) || !isFinite(lng) || !enPanama(lat, lng)) return null;
  const tipos: string[] = p.types || []; const zona = tipos.length > 0 && tipos.every((t) => ZONA.has(t));
  return { lat, lng, estado: zona ? "aproximada" : "automatica", fuente: "google_places", detalle: limpio(`${p.displayName?.text || ""} · ${p.formattedAddress || ""}`).slice(0, 300) };
}
export function clasificarGeocoding(g: any, fuente = "google_geocoding") {
  const lat = Number(g?.geometry?.location?.lat), lng = Number(g?.geometry?.location?.lng);
  if (!isFinite(lat) || !isFinite(lng) || !enPanama(lat, lng)) return null;
  const exacta = ["ROOFTOP", "RANGE_INTERPOLATED"].includes(g.geometry?.location_type) && !g.partial_match;
  const tipos: string[] = g.types || []; const zona = tipos.length > 0 && tipos.every((t) => ZONA.has(t));
  return { lat, lng, estado: exacta && !zona ? "automatica" : "aproximada", fuente, detalle: limpio(g.formatted_address).slice(0, 300) };
}
