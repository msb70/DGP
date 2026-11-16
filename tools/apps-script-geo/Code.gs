/**
 * DGP · Geocodificador gratuito con Apps Script (servicio Maps de Google, sin tarjeta ni API key).
 *
 * Lo llama la plataforma DGP (funciones "geo" y "zoho" de Supabase) para calcular las coordenadas
 * de las direcciones de clientes y de entrega. Responde en el mismo formato que la Geocoding API de Google.
 *
 *   GET <URL de la aplicación web>?clave=<CLAVE>&q=<dirección>
 *   → { status: "OK" | "ZERO_RESULTS" | "OVER_DAILY_LIMIT" | "REQUEST_DENIED" | ..., results: [ ... ] }
 *
 * Cuota (cuenta que publica el script): ~1.000 consultas/día con Gmail, ~10.000/día con Google Workspace.
 * Cuando se agota responde OVER_DAILY_LIMIT y la plataforma se detiene hasta el día siguiente.
 * Las respuestas se guardan 6 horas en caché: repetir una dirección no gasta cuota.
 *
 * Instalación: ver LEEME.md en esta misma carpeta.
 */

// Rectángulo de Panamá: orienta la búsqueda hacia Panamá (no excluye resultados de fuera; eso lo filtra la plataforma).
var PANAMA = { sur: 7.0, oeste: -83.1, norte: 9.7, este: -77.1 };
var CACHE_SEG = 21600; // 6 horas (máximo de CacheService)

function doGet(e) {
  var p = (e && e.parameter) || {};
  var clave = PropertiesService.getScriptProperties().getProperty('CLAVE');
  if (!clave) return salida_({ status: 'CONFIG', error_message: 'Falta la propiedad del script CLAVE (Configuración del proyecto → Propiedades del script).' });
  if (!p.clave || p.clave !== clave) return salida_({ status: 'REQUEST_DENIED', error_message: 'Clave incorrecta' });

  var q = String(p.q || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!q) return salida_({ status: 'INVALID_REQUEST', error_message: 'Falta q (la dirección)' });

  var cache = CacheService.getScriptCache();
  var k = 'g:' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, q, Utilities.Charset.UTF_8));
  var guardado = cache.get(k);
  if (guardado) return ContentService.createTextOutput(guardado).setMimeType(ContentService.MimeType.JSON);

  try {
    var r = Maps.newGeocoder()
      .setRegion('pa')
      .setLanguage('es')
      .setBounds(PANAMA.sur, PANAMA.oeste, PANAMA.norte, PANAMA.este)
      .geocode(q);
    var out = {
      status: r.status,
      results: (r.results || []).slice(0, 1).map(function (x) {
        return {
          formatted_address: x.formatted_address,
          types: x.types || [],
          partial_match: !!x.partial_match,
          geometry: { location: { lat: x.geometry.location.lat, lng: x.geometry.location.lng }, location_type: x.geometry.location_type }
        };
      })
    };
    var texto = JSON.stringify(out);
    if (r.status === 'OK' || r.status === 'ZERO_RESULTS') cache.put(k, texto, CACHE_SEG);
    return ContentService.createTextOutput(texto).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    var m = String((err && err.message) || err);
    var limite = /too many times|demasiadas veces|quota|cuota/i.test(m);
    return salida_({ status: limite ? 'OVER_DAILY_LIMIT' : 'UNKNOWN_ERROR', error_message: m.slice(0, 300) });
  }
}

function salida_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Ejecutar una vez desde el editor: pide los permisos y comprueba que el servicio responde. */
function probar() {
  var r = Maps.newGeocoder().setRegion('pa').setLanguage('es').geocode('Vía España, Panamá');
  Logger.log('Estado: %s · %s', r.status, r.results && r.results[0] ? r.results[0].formatted_address : '(sin resultado)');
}

/** Ejecutar una vez desde el editor: crea la propiedad CLAVE con un valor aleatorio si no existe (no la muestra). */
function crearClave() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('CLAVE')) { Logger.log('La propiedad CLAVE ya existe: no se cambia.'); return; }
  props.setProperty('CLAVE', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  Logger.log('CLAVE creada. Cópiala desde Configuración del proyecto → Propiedades del script al formulario seguro de la plataforma.');
}
