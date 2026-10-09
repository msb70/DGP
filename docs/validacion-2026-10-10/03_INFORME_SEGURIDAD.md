# Informe ejecutado: seguridad
Fecha: 10 de octubre de 2026 · Base af5e998, rama main + cambios de infraestructura de pruebas. Entorno macOS arm64, PostgreSQL 16.14 local en 127.0.0.1:55439, Node 22.23.2 y Deno 2.9.6.

## Estado tras la corrección (Claude · 10-oct-2026)
Entorno de la re-ejecución: Linux x64, PostgreSQL embebido 16.14 en 127.0.0.1:55439 (mismo runner `npm run test:qa`), Node 22, Deno 2.9.6, Playwright 1.64 (Chromium/Firefox/WebKit). Rama `qa-correcciones` sobre `main` 892da4f. **Emulador local**: PostgreSQL real con RLS, Auth/PostgREST emulados, Meta y Zoho simulados. No es staging ni proveedor real.

**Dictamen: hallazgos críticos/altos corregidos en local; no aprobar producción hasta aplicar la migración y re-probar en staging.** SQL adicional 9/9 (antes 2/4; +5 regresiones nuevas), RLS original aprobada. Evidencia: [sql-audit.json](evidencias/sql-audit.json), [policies.json](evidencias/policies.json) · antes: [antes-correccion/sql-audit.json](evidencias/antes-correccion/sql-audit.json).

| ID | Causa raíz | Cambio | Archivos | Prueba | Antes → después |
|---|---|---|---|---|---|
| SEG-06 (crítica) | `htmlPaquete` interpolaba la firma en `src="…"`; el saneamiento quita `<>` pero no comillas | (1) Render: solo se pinta si es `data:image/png|jpeg;base64,…`, lo demás se descarta. (2) Base: CHECK de formato en `firma_conductor`/`firma_verificador`. (3) El conductor ya no puede escribir paquetes | public/js/salida.js:65–68,76; supabase/v3_produccion.sql:707–711 | «firma guardada no ejecuta código» | marcador ejecutado → no ejecutado |
| SEG-01 (alta) | Política `p_upd` de paquetes permitía `ruta_propia` (conductor) en todas las columnas | Paquetes: solo quien tiene permiso de escritura de paquetes (verificar/bodega/gd/planificar). La app del conductor no escribe paquetes | supabase/v3_produccion.sql:585–592 | «conductor no puede falsificar firma» + nueva SQL «conductor no puede modificar paquetes» | firma falsa guardada → 0 filas |
| SEG-05 (alta) | `p_upd` de rutas con `ruta_propia` sin límite de columnas ni transiciones | Trigger `guardia_conductor`: para el conductor, solo las columnas que usa la app y transiciones `liberada→en_ruta`, `en_ruta→cerrada` (error 42501). Aplicado también a paradas (check-in/entrega), pedidos (`planificado→entregado/parcial/no_entregado`, sin tocar valor) y líneas (`entregado`) | supabase/v3_produccion.sql:646–680 | «conductor no puede liberar su ruta» (rechazo 42501) + nuevas: transición legítima sí funciona; no cambia fecha/vehículo; no cambia valor de pedido y sí marca entregado | 1 fila modificada → rechazado |

Nota sobre la prueba de SEG-05: la aserción original exigía «0 filas afectadas»; ahora la base **rechaza con error de permiso (42501)**, que es más estricto. La aserción acepta ambas formas de denegación; no se relajó. El fixture de `tests/sql/10_rls_test.sql` marca como `planificado` el pedido asignado a la ruta (antes `pendiente_validar`, un estado imposible para un pedido en ruta).

**Pendiente — decisión de DGP, no corregido:** alcance de lectura de ejecutivo (lee todos los pedidos/clientes; ¿solo los suyos?), ayudante (lee maestros por API aunque no entra a la UI) y conductor (lee todos los clientes y personas). Hay que definir el alcance antes de tocar políticas. También pendientes: matriz completa de escrituras/acciones Edge, refresh/logout real de GoTrue, rate limit IA, CSP/CORS/verify_jwt desplegados (vercel.json mantiene `unsafe-inline`), exportación CSV con fórmulas, retención de imágenes y foto/firma de **paradas** (se pintan solo en la app del conductor; falta el mismo CHECK de formato).

---
## Informe original de Codex (reproducción previa a la corrección)
## Dictamen: no aprobar pase a producción
Suite RLS original aprobada. Se evaluaron 495 lecturas: 15 roles × 33 tablas públicas; también denegación anon en cada tabla, errores deliberados del runner y mutación de ruta propia. [Matriz](evidencias/role-read-matrix.json), [políticas](evidencias/policies.json), [SQL adicional](evidencias/sql-audit.json). La matriz es de lectura; no equivale a cobertura de todas las acciones CRUD/RPC por rol.

| ID | Severidad | Reproducción | Observado | Corrección y regresión |
|---|---|---|---|---|
| SEG-01 | Alta | Conductor PATCH a paquete propio con firma_verificador, books_shipment_id y estado registrado | HTTP 200 y firma falsa almacenada | Restringir columnas/acciones y transiciones en servidor; conductor no puede certificar verificación o Zoho |
| SEG-05 | Alta | Conductor cambia su ruta de publicada a liberada mediante SQL bajo SET ROLE authenticated y claims reales | 1 fila modificada, sin intervención del verificador | RPC de transición validada y restricciones de escritura; no confiar en UI |
| SEG-06 | Crítica | Conductor guarda firma_verificador con valor `x" onerror="window.__qaXss=1`; admin obtiene el paquete y renderiza htmlPaquete(q) | HTTP 200; marcador JavaScript ejecutado en DOM de administración | Validar firma como dato de imagen, renderizar con APIs DOM/contexto seguro, impedir escritura del conductor y endurecer CSP |

SEG-06 no extrajo sesiones ni datos: solo un marcador de prueba. htmlPaquete(q) interpola firma directamente en atributo img src; quitar < y > en trigger no impide inyección por comillas. La prueba usa la función real y un contenedor DOM oculto que se elimina; no hizo clic en imprimir. El servidor QA no aplica las cabeceras del hosting; vercel.json permite unsafe-inline, pero no se verificó CSP desplegada. Vulnerabilidad reproducida en código/local, no explotación de producción.

Fuente: RLS supabase/v3_produccion.sql:565–566,579; render public/js/salida.js:73; saneamiento v3:474–481. Reproducción automática: tests/qa/extended-e2e.mjs y tests/qa/sql-audit.mjs. Valores/status: [qa-extended.json](evidencias/e2e/qa-extended.json).

## Alcance de lectura observado
Conductor lee los 36 clientes y 29 personas del maestro. Ejecutivo de prueba lee los 40 pedidos y 36 clientes; la descripción del rol dice sus clientes, pero la RLS de oficina no aplica ese filtro. Ayudante activo, descrito sin acceso a plataforma, lee maestros por API aunque la UI no le permita entrar. Claude debe resolver el alcance requerido por DGP y alinear políticas con esa definición. Esto está observado en matriz; no se decidió automáticamente que todas esas lecturas sean ilegítimas.

## Controles aprobados
Anon sin lectura de tablas, sin_rol sin pedidos; rutas ajenas denegadas en casos originales; altas/roles protegidos, último admin, auditoría inmutable y actor sellado; webhook firma falsa/secretos incorrectos rechazados. Desactivar usuario bloquea los flujos ensayados.

## Dependencias
npm audit del entorno de pruebas: 0 avisos. Auditoría adicional por versiones de @supabase/supabase-js 2.117.3, Leaflet 1.9.4, PapaParse 5.4.1 y qrcodejs 1.0.0: 0 avisos. [npm-audit.json](evidencias/npm-audit.json), [vendor-audit.json](evidencias/vendor-audit.json). La segunda consulta usa paquetes npm equivalentes; no demuestra integridad binaria/procedencia exacta de cada archivo vendorizado ni ausencia de vulnerabilidades desconocidas.

## Pendiente
Matriz completa de escrituras/acciones Edge, revocación/refresh/logout real de GoTrue, controles de coste/rate limit IA, cuerpo malformado y timeout de proveedor, CSP/CORS/HTTPS/verify_jwt desplegados, auditoría de secretos e integridad vendor exhaustivas, exportación CSV con fórmulas y retención de imágenes. Sin staging ni cuentas autorizadas de prueba no se da aprobación de producción.
