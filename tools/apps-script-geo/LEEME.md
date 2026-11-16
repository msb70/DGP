# Geocodificador gratuito con Apps Script (DGP)

Calcula las coordenadas de las direcciones de clientes y de entrega usando el servicio Maps de Apps Script.
No requiere tarjeta ni API key de Google Cloud. Cuota aproximada: 1.000 consultas/día con una cuenta Gmail,
10.000/día con Google Workspace (la de la cuenta que publica el script). Si se agota, la plataforma se detiene y
continúa al día siguiente. Las respuestas se guardan 6 h en caché.

La plataforma lo usa solo si NO existe el secreto `GOOGLE_MAPS_API_KEY` (si existe, manda Google Maps de pago).

## Instalación (10 minutos)
1. https://script.google.com → **Nuevo proyecto** → nombre «DGP Geocodificador».
   Usar la cuenta de Google de DGP o una de servicio (no una personal que pueda irse).
2. Pegar `Code.gs` (reemplazando el contenido). En Configuración del proyecto, marcar «Mostrar el archivo de manifiesto
   appsscript.json en el editor» y pegar `appsscript.json`.
3. Ejecutar la función **`crearClave`** (selector de funciones → Ejecutar). Acepta los permisos.
4. Ejecutar **`probar`**: en el registro debe salir `Estado: OK · Vía España, Panamá`.
5. **Implementar → Nueva implementación → Aplicación web**:
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier usuario**
   → Implementar → copiar la **URL de la aplicación web** (termina en `/exec`).
6. Guardar en el formulario seguro (no en el chat):
   - `url` = la URL `/exec`
   - `clave` = Configuración del proyecto → Propiedades del script → valor de `CLAVE`
   Quedan en Infisical como `automind/dgp/prod/APPS_SCRIPT_GEO_URL` y `APPS_SCRIPT_GEO_CLAVE` y se inyectan como secretos
   de las Edge Functions de Supabase con los mismos nombres.
7. En la plataforma: Integraciones → tarjeta «Coordenadas» debe mostrar «Apps Script (gratis)» y estado conectado →
   **Calcular coordenadas**.

## Cambios posteriores
Si se modifica el código: Implementar → Gestionar implementaciones → editar la existente → Versión: nueva.
Así la URL no cambia. Una implementación nueva genera otra URL y habría que actualizar el secreto.

## Seguridad
- Sin la clave la aplicación responde `REQUEST_DENIED`.
- Para cambiar la clave: borrar la propiedad `CLAVE`, ejecutar `crearClave` y volver a guardar el secreto.

## Límites
- Solo geocodifica por dirección (no encuentra un negocio por su nombre como Places). Si la dirección sola no aparece,
  la plataforma prueba «nombre del local, dirección». Las direcciones descriptivas quedarán a menudo como «aproximada».
- Son datos de Google: aplican sus condiciones de uso (no guardar coordenadas de forma permanente ni usarlas en mapas que
  no sean de Google). Para el SaaS con varios clientes, usar la API de pago.
