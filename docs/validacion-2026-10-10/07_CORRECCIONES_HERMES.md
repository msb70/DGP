# Correcciones de la revisión de Hermes (10-oct-2026)

**Base:** `main` @ `e09b62ada80665aab38f8e2e745952535d0d0387` · **Rama de trabajo:** `hermes-correcciones`
**Entorno de prueba:** Linux x64, PostgreSQL embebido 16.14 (127.0.0.1:55439), Node 22, Deno 2.9.6, Playwright 1.64 (Chromium, Firefox, WebKit). **Emulador local**: PostgreSQL real con RLS; Auth/PostgREST emulados; Meta y Zoho simulados. No es staging ni proveedor real.

**Resultado:** los 7 bloqueantes (P0), 3 de los 4 pendientes conocidos y los 3 P1 corregidos con regresión. La matriz completa de escritura por rol (KNOWN-RBAC-001) queda pendiente de decisión de DGP.

## Hallazgo adicional (no estaba en el informe): defecto en la migración 10b ya desplegada
`dgp_private.guardia_conductor()` evaluaba `new.estado` también en `pedido_lineas`, que no tiene esa columna. PL/pgSQL lo resuelve igual y falla (`42703`). **Efecto en producción:** la primera entrega parcial de un conductor fallaría y, como 42703 no se considera error permanente, quedaría reintentándose en la cola del teléfono y bloquearía los eventos siguientes. Sin impacto real todavía (no hay conductores dados de alta). Corregido leyendo el estado vía `to_jsonb`; cubierto por las pruebas de entrega parcial (SQL y navegador). Va en la migración 10c.

## Por hallazgo

| ID | Causa | Cambio | Archivos | Regresión |
|---|---|---|---|---|
| OPS-001 | El runbook revertía ejecutando `schema.sql` (crea `demo_all`) | Runbook reescrito: se revierte web y funciones; la base 10b/10c es compatible hacia atrás. `reversion_segura.sql` retira triggers/CHECK/RPC nuevos **sin tocar RLS ni auth** y sin reabrir SEG-01. Aviso «solo demo» en cabecera de `schema.sql` y `dgp_mvp_completo.sql` | docs/PASE_A_PRODUCCION.md; supabase/migraciones/reversion_segura.sql; supabase/schema.sql; supabase/dgp_mvp_completo.sql | sql-hermes: tras la reversión 0 `demo_all` y `anon` sin SELECT/INSERT/UPDATE/DELETE en las 33 tablas; v3 se reaplica y restaura protecciones |
| LOGIC-001 | `promesaPago()` ponía `elegible` a todo pedido `en_excepcion` del cliente | Una sola evaluación canónica `evaluarCliente()` para validar y promesa; la promesa se guarda en los pedidos abiertos del cliente y se reevalúa: solo levanta crédito | public/js/app.js (`evaluarCliente`, `promesaPago`) | E2E: crédito+dirección dudosa → sigue en excepción; crédito+B/.1 → sigue; solo crédito → elegible. Código: casos de `validar()` existentes |
| LOGIC-002 | `cerrar()` procesaba rutas activas e inventaba km, consumo y peajes | RPC atómica `conciliar_ruta(rid)`: solo `cerrada`, odómetros y abastecimientos reales, peajes solo registrados. Sin datos → `costos_ruta.datos_completos=false` + `faltantes`, la ruta sigue `cerrada`. Idempotente. La pantalla la usa en producción; la simulación queda solo en modo demo y solo sobre cerradas | supabase/v3_produccion.sql §10c; public/js/app.js (`cerrar`, `conciliarReal`) | SQL: rechaza publicada (22023) y conductor (42501); sin datos queda pendiente; con datos concilia exactamente (80 km, 15 L, B/.14,70, peaje 2,75); repetir no crea peajes ni costos. E2E: publicada/en_ruta intactas y sin costos; 2ª ejecución sin auditoría duplicada |
| DATA-001 | `Q.push` enterraba el error y devolvía `false`; los llamadores seguían y mostraban éxito | `Q.push` devuelve `ok`/`cola`/`rechazado`; `paso()` lanza ante rechazo; cada acción del conductor se detiene, recarga el estado del servidor y conserva el formulario. Estado local solo tras guardar. Entrega = RPC atómica `registrar_entrega` (parada+pedido+líneas). Cantidades validadas (entero 0..requerido) en cliente y base | public/js/conductor.js; supabase/v3_produccion.sql §10c | E2E con fallo inyectado en salida, check-in, entrega y cierre: sin evento siguiente, sin avisos, mensaje de error, estado intacto; luego el camino legítimo funciona. Parcial con -1, 4 (>3), 1.5 y vacío: 0 envíos. SQL: línea ajena → nada cambia; negativo/excedente → 23514 sin efecto parcial; reintento idempotente |
| ZOH-001 | update cabecera → delete líneas → insert líneas sin transacción | RPC `zoho_guardar_pedido(pedido, lineas)` (service_role): todo o nada | supabase/v3_produccion.sql §10c; supabase/functions/zoho/index.ts | SQL: orden existente con línea inválida queda idéntica (cabecera y líneas); orden nueva inválida no crea filas; orden sin líneas rechazada |
| ZOH-002 | Escrituras locales tras efectos en Zoho sin comprobar; Books sin reconciliación | `guardarLocal()` comprueba cada escritura y responde error si falla. Reconciliación previa a crear: Inventory por id/número de paquete **y su envío** (cerraba un hueco propio: con el paquete ya guardado se creaba un segundo envío); Books por comentario «DESPACHO DGP <número> ·» | supabase/functions/zoho/index.ts, mapeo.ts | E2E: Zoho OK + fallo local → 500 «no se pudo guardar en DGP», paquete desbloqueado; reintento → 1 paquete y 1 envío en total. Deno: búsqueda de paquete y de comentario (PQ-1 no coincide con PQ-10) |
| WA-001 | El webhook respondía 200 aunque fallara | 500 ante cualquier error (Meta reintenta); errores de cada escritura comprobados; procesamiento idempotente (estados por `wa_message_id` sin retroceder, entrantes con upsert) | supabase/functions/whatsapp/index.ts | E2E: base fallando → 500; tras recuperar, 2 reintentos → 200 y una sola actualización |
| KNOWN-WA-001 | Cualquier activo podía crear avisos con teléfono/plantilla propios y disparar `procesar` | Sin `notificaciones.enviar`: solo avisos de sus rutas, a clientes de esas rutas; teléfono, plantilla y destinatario los fija el servidor. `procesar` masivo solo cron o `notificaciones.enviar`; los demás solo sus avisos pendientes | supabase/v3_produccion.sql §10c (`restringir_notificacion`); whatsapp/index.ts | SQL: cliente fuera de ruta → 42501; teléfono/plantilla inventados se ignoran. RLS: teléfono escrito en el texto rechazado. E2E: conductor → 403 al envío masivo; aviso ajeno → 0 procesados |
| KNOWN-WA-002 | `enviando` quedaba atascado para siempre | `enviando_at` + recuperación a los 10 min si no hay `wa_message_id` (máx. 3 intentos) | supabase/v3_produccion.sql §10c | SQL: atascado 20 min → se recupera; reciente → no |
| KNOWN-SEC-002 | `tomar_pendientes` sin revocar a `public`/`anon` | Revocado; privilegios por defecto del esquema privado sin EXECUTE público | supabase/v3_produccion.sql §10c | SQL: anon/authenticated sin EXECUTE en 4 funciones de servidor |
| TIME-001 | Separaba horas y minutos antes de redondear | Se redondea el total y se envuelve en 24 h (app y conductor) | public/js/app.js, conductor.js | Código: 08:59.4, 08:59.6, 23:59.6, cruce de medianoche, 0 |
| QA-001 | GD fallaba en cascada; Firefox en macOS | Pruebas con prerrequisito quedan **bloqueadas** (no fallo independiente, la suite sigue en error). Tres ejecuciones consecutivas limpias (abajo) | tests/e2e/run.mjs | — |
| CI-001 | Sin CI | Workflow `QA` en cada push/PR con la suite completa, `npm audit` y evidencias | .github/workflows/qa.yml | — |

Además: `dgp_private.es_usuario_app()` distingue al usuario de la app (rol activo `authenticated`/`anon`) del servidor y del SQL Editor; antes bastaba `auth.uid()`, que puede quedar en la sesión tras `reset role`. La prueba RLS original de notificaciones se actualizó: comprobaba justo el camino que KNOWN-WA-001 prohíbe (teléfono escrito a mano, sin cliente); ahora prueba el camino legítimo y que el otro se rechaza. El fixture asigna `planificado` al pedido en ruta. La prueba de costos cierra antes la ruta desde la app del conductor (precondición real de LOGIC-002). Ninguna aserción se relajó.

## Ejecuciones
`npm run test:qa --prefix tests` (incluye: sintaxis, 8 Edge, typecheck de 4 funciones, RLS, código/datos 12, SQL adicional 9, SQL Hermes 11, E2E 46 con Firefox y WebKit).

| Corrida | Código de salida | Código/datos | Edge | Typecheck | RLS | SQL adicional | SQL Hermes | E2E |
|---|---|---|---|---|---|---|---|---|
| 1 | 0 | 12/12 | 8/8 | 4/4 | OK | 9/9 | 11/11 | 46/46 (0 bloqueadas) |
| 2 | 0 | 12/12 | 8/8 | 4/4 | OK | 9/9 | 11/11 | 46/46 (0 bloqueadas) |
| 3 | 0 | 12/12 | 8/8 | 4/4 | OK | 9/9 | 11/11 | 46/46 (0 bloqueadas) |

Puertos 55439, 54321, 8080 y 8201–8204 libres tras las tres corridas. Evidencias: [sql-hermes.json](evidencias/sql-hermes.json), [qa-hermes.json](evidencias/e2e/qa-hermes.json), [resultados.json](evidencias/e2e/resultados.json), [ejecucion.json](evidencias/ejecucion.json).

## Pendiente (requiere DGP, staging o proveedor real)
- **KNOWN-RBAC-001:** matriz rol × tabla × columna × transición para ejecutivo, verificador, bodega, costos y planificación. El conductor ya está acotado. Hace falta que DGP defina el alcance de cada rol antes de escribir políticas.
- **Alcance de lectura** de ejecutivo/ayudante/conductor; ventana offline de 72 h; retención de PII, fotos y firmas.
- **Vercel aún publica cada push a `main`.** Para que CI bloquee: protección de rama exigiendo el check «QA completa» y fusionar por PR.
- **Firefox en macOS** («Could not find profile folder») no se reprodujo en Linux; parece del entorno de Hermes (perfil/TMPDIR). El CI corre Firefox en Linux.
- **Staging Supabase**, cuentas sandbox de Meta/Zoho (confirmar que `GET /packages` y `GET /comments` devuelven `package_number`/`shipment_id`/`description` como asume la reconciliación), teléfonos físicos, carga sostenida, backup/PITR.
- **WhatsApp:** recuperar un aviso `enviando` sin respuesta puede duplicar el mensaje si Meta sí lo envió (Meta no ofrece clave de idempotencia). Se limita a 3 intentos.
