/* Servicios geográficos gratuitos: OSRM (rutas por calle), Nominatim (geocodificación). Sin claves. */
window.GEO = (function () {
  const OSRM = 'https://router.project-osrm.org';
  const NOMINATIM = 'https://nominatim.openstreetmap.org';
  const km = (a, b) => { const R = 6371, dl = (b.lat - a.lat) * Math.PI / 180, dg = (b.lng - a.lng) * Math.PI / 180, x = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dg / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
  const kmVia = (a, b) => km(a, b) * 1.35; // factor de sinuosidad urbana cuando no hay OSRM
  const metros = (a, b) => km(a, b) * 1000;
  /* Ruta por calle entre puntos ordenados. Devuelve {coords:[[lat,lng]...], legs:[{km,min}], km, min} o null. */
  async function route(points) {
    if (points.length < 2) return null;
    try {
      const c = points.map(p => `${p.lng},${p.lat}`).join(';');
      const r = await fetch(`${OSRM}/route/v1/driving/${c}?overview=full&geometries=geojson&steps=false`, { signal: AbortSignal.timeout(12000) });
      const j = await r.json(); if (j.code !== 'Ok') return null;
      const rt = j.routes[0];
      return { coords: rt.geometry.coordinates.map(([x, y]) => [y, x]), legs: rt.legs.map(l => ({ km: l.distance / 1000, min: l.duration / 60 })), km: rt.distance / 1000, min: rt.duration / 60 };
    } catch (e) { console.warn('OSRM no disponible', e); return null; }
  }
  /* Geocodificar una dirección en Panamá. */
  async function geocode(q) {
    try {
      const r = await fetch(`${NOMINATIM}/search?${new URLSearchParams({ q, format: 'json', limit: 1, countrycodes: 'pa' })}`, { headers: { 'Accept-Language': 'es' }, signal: AbortSignal.timeout(12000) });
      const j = await r.json(); if (!j.length) return null;
      return { lat: +j[0].lat, lng: +j[0].lon, display: j[0].display_name };
    } catch (e) { return null; }
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  return { km, kmVia, metros, route, geocode, sleep };
})();
