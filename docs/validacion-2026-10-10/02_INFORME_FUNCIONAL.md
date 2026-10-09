# Informe ejecutado: pruebas funcionales
Fecha: 10 de octubre de 2026 · Base af5e998, rama main + cambios de infraestructura de pruebas. Entorno macOS arm64, PostgreSQL 16.14 local en 127.0.0.1:55439, Node 22.23.2 y Deno 2.9.6.

## Estado tras la corrección (Claude · 10-oct-2026)
Entorno de la re-ejecución: Linux x64, PostgreSQL embebido 16.14 en 127.0.0.1:55439 (mismo runner `npm run test:qa`), Node 22, Deno 2.9.6, Playwright 1.64 (Chromium/Firefox/WebKit). Rama `qa-correcciones` sobre `main` 892da4f. **Emulador local**: PostgreSQL real con RLS, Auth/PostgREST emulados, Meta y Zoho simulados. No es staging ni proveedor real.

**Dictamen: corregido en local.** E2E 36/36 (antes 28/35; +1 regresión nueva de reconciliación Zoho; Firefox/WebKit smoke aprobados). Evidencia: [resultados.json](evidencias/e2e/resultados.json), [qa-extended.json](evidencias/e2e/qa-extended.json), [qa-despues.log](evidencias/qa-despues.log) · antes: [antes-correccion/](evidencias/antes-correccion/).

| ID | Causa raíz | Cambio | Archivos | Prueba | Antes → después |
|---|---|---|---|---|---|
| FUN-05 | `registrar_envio` comprobaba `books_shipment_id` y luego llamaba a Zoho sin exclusión: dos llamadas simultáneas pasaban la comprobación | Reclamo atómico en base (`zoho_reclamar_paquete`, bloqueo de 2 min) antes de llamar a Zoho; la segunda llamada recibe HTTP 409 «ya se está registrando»; liberación en `finally`. Reconciliación: antes de crear el paquete se busca en Zoho uno con el mismo `package_number` y se reutiliza (y su envío si existe) | supabase/functions/zoho/index.ts:198–250; supabase/v3_produccion.sql:713–721 | «dos registros simultáneos no duplican» (paquete nuevo) + **nueva** «respuesta perdida tras crear el paquete no duplica» | 2 paquetes + 2 envíos → 1 + 1 (estados 200/409); reintento tras pérdida: 0 nuevos |
| FUN-06 | El id del evento se generaba en cada intento (`DB.insert` → `uuid()`): el reintento era otra fila | La cola asigna id estable al encolar; en reintento, clave duplicada (23505) = «ya guardado», sin duplicar ni enterrar como error | public/js/conductor.js:19–22; public/js/db.js:88–95 | «respuesta perdida tras commit no duplica evento» | 2 eventos → 1 |
| FUN-07 | Arranque dependía de red: `mi_perfil` (auth.js), sondeo de `reglas` (db.js) y `load()`; además el cliente Supabase reintenta con espera (>5 s) | Perfil verificado y copia de trabajo por usuario (sus rutas, paradas, pedidos, líneas, paquetes y solo los clientes de sus paradas) en el teléfono; sin señal se arranca de la copia sin tocar la red; validez 72 h; al volver la señal se revalida el perfil (usuario desactivado o sin rol → bloqueo, la cola queda guardada) y se sincroniza. La cabecera muestra la hora de los datos. SW `v5`, `ignoreSearch` | public/js/auth.js:90–130; public/js/db.js:44–47; public/js/conductor.js:30–55, 220–232; public/sw.js | «arranque offline mantiene operación» | 0 rutas operables → 1; arranque < 2,5 s |
| SEG-01/05/06 | ver informe 03 | | | | |

**Decisiones de diseño que DGP debe validar:** ventana offline de 72 h; que la copia incluya nombre/dirección/teléfono de los clientes de las paradas (necesario para entregar sin señal).

**Pendiente (sin cambio):** cámara/GPS en Android/iOS físicos, PWA instalada bajo HTTPS, 100 eventos offline + cambio de usuario en el mismo teléfono, recuperación de contraseña con correo real, accesibilidad, y **staging Supabase + cuentas de prueba de Meta/Zoho**. Zoho real: falta comprobar que `GET /packages?salesorder_id` devuelve `package_number` y `shipment_id` como asume la reconciliación.

---
## Informe original de Codex (reproducción previa a la corrección)
## Dictamen: requiere correcciones
25/25 escenarios originales aprobados. Suite ampliada total: 27/34 aprobados y 7 fallidos. Incluye 7 regresiones nuevas fallidas y 2 smoke tests aprobados en Firefox/WebKit. No hubo pageerror inesperado registrado. Evidencia por caso: [resultados.json](evidencias/e2e/resultados.json), [e2e.log](evidencias/e2e.log) y capturas en evidencias/e2e/.

Se validaron acceso/cambio temporal, usuarios/roles, planificación/publicación, permisos API, sincronización, cantidades verificadas, ruta propia, salida, firma webhook, entrega/no entrega, combustible/demora, documentos, costos e incentivos. Meta y Zoho son mocks; Supabase Auth/PostgREST es un emulador sobre PostgreSQL con RLS real. OSRM/mapas/fonts se bloquearon deliberadamente; la planificación usa fallback. Pasar estos casos no confirma integraciones comerciales reales.

| ID | Severidad | Pasos y evidencia | Resultado observado | Acción requerida |
|---|---|---|---|---|
| FUN-05 | Alta | Dos POST registrar_envio simultáneos sobre el mismo paquete sin registro previo | 2 paquetes y 2 envíos Zoho, ambos HTTP 200 | Exclusión/idempotencia persistente, identidad única por operación y reconciliación tras fallo externo |
| FUN-06 | Alta | DB.insert guarda evento pero se simula pérdida de respuesta; Q.push encola y Q.flush reintenta | 2 eventos persistidos para una operación; cola vacía | UUID/idempotency key estable antes del primer envío, retry sin duplicación y tratamiento de conflicto |
| FUN-07 | Alta | Conductor autenticado, service worker activo/controlando; recarga online, modo offline real de navegador y nueva recarga | Shell visible; falla RPC de perfil, 0 rutas operables | Diseñar arranque y datos offline por usuario, sesión y reglas de revocación; sincronización posterior verificable |

Además fallan casos de seguridad, dato negativo y tope de lectura: consultar informes 01/03/04. Fuente FUN-05: supabase/functions/zoho/index.ts:145–175. FUN-06: public/js/conductor.js:19–21 y generación de id en public/js/db.js:83. FUN-07: public/js/auth.js:98–100, public/js/db.js:48–50 y conductor.js:188–202.

Las pruebas se implementan en tests/qa/extended-e2e.mjs. [qa-extended.json](evidencias/e2e/qa-extended.json) registra cantidades y estados. [PWA offline](evidencias/e2e/pwa-offline.png) muestra fallo de perfil. La pérdida de respuesta se inyectó en cliente después de commit real; es un ensayo de fault injection, no un incidente real.

## Navegadores
Chromium: flujo completo y viewport conductor móvil. Firefox: login→torre sincronizada 911 ms. WebKit: 1507 ms. Estos dos motores solo tuvieron smoke de login/torre, no 25 escenarios completos. No sustituyen Android/iOS físicos, cámara/GPS y PWA instalada bajo HTTPS.

## Pendiente
Cámara real, permiso GPS denegado en móvil físico, instalación/actualización PWA completa, recuperación de contraseña con correo real, 100 eventos offline y cambio de usuario, interfaces/accessibilidad exhaustivas, y validación con staging Supabase y cuentas de proveedor de prueba. No hubo pruebas sobre producción. Las correcciones deben conservar los casos fallidos y lograr su aprobación antes del pase.
