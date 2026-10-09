# Informe ejecutado: código y datos
Fecha: 10 de octubre de 2026 · Base af5e998, rama main + cambios de infraestructura de pruebas. Entorno macOS arm64, PostgreSQL 16.14 local en 127.0.0.1:55439, Node 22.23.2 y Deno 2.9.6.

## Estado tras la corrección (Claude · 10-oct-2026)
Entorno de la re-ejecución: Linux x64, PostgreSQL embebido 16.14 en 127.0.0.1:55439 (mismo runner `npm run test:qa`), Node 22, Deno 2.9.6, Playwright 1.64 (Chromium/Firefox/WebKit). Rama `qa-correcciones` sobre `main` 892da4f. **Emulador local**: PostgreSQL real con RLS, Auth/PostgREST emulados, Meta y Zoho simulados. No es staging ni proveedor real.

**Dictamen: corregido en local.** Código y datos 11/11 (antes 8/11). Evidencia: [code-data.json](evidencias/code-data.json) · antes: [antes-correccion/code-data.json](evidencias/antes-correccion/code-data.json).

| ID | Causa raíz | Cambio | Archivos | Prueba | Antes → después |
|---|---|---|---|---|---|
| COD-04 | En `validar()` la rama `credito_bloqueado && promesa_pago` era un `else if` que cortaba la cadena: con promesa nunca se evaluaban dirección ni mínimo | Crédito, dirección y mínimo se evalúan por separado; la promesa solo levanta el crédito y se anota en la causa | public/js/app.js:76–98 | «promesa de pago no omite dirección dudosa» | elegible → en_excepcion |
| COD-05 | Misma rama; además el complemento sumaba facturas bloqueadas | Igual; el complemento suma solo facturas que pasan crédito y dirección | public/js/app.js:82–92 | «promesa de pago no omite monto mínimo» (+ «mínimo y complemento» sigue aprobado) | elegible → en_excepcion |
| COD-06 | `hoy()` usaba `toISOString()` (UTC); la base de Supabase también corre en UTC (`TimeZone=UTC`, verificado en producción) | `hoy()`/`fechaPA()` con `Intl` y `America/Panama`; `diasAtras` y fecha de promesa; Edge Zoho (`hoyPanama`, fecha de paquete); defaults `fecha` de pedidos/rutas/actas en hora de Panamá | public/js/app.js:7–8,34,101; supabase/functions/zoho/index.ts, mapeo.ts; supabase/v3_produccion.sql:726–728 | «Fecha operativa Panamá en medianoche UTC» | 10-oct → 9-oct |
| DAT-02 | Sin restricciones de dominio en cantidades/importes | CHECK no negativos en líneas (incl. `entregado` ≤ cantidad), pedidos, capacidades y odómetro llegada ≥ salida | supabase/v3_produccion.sql:694–704 | «cantidades negativas se rechazan» + «odómetro regresivo se rechaza» | HTTP 201 → rechazo (23514) |
| DAT-03 | `estado` era texto libre | CHECK con el dominio documentado en el esquema para rutas, pedidos, paradas y paquetes | supabase/v3_produccion.sql:683–691 | «Ruta no acepta estado arbitrario» | aceptado → rechazado |
| COD-03 | Guía decía que `main` servía la demo v2 | Guía actualizada al estado real (v3 en `main`) | docs/PASE_A_PRODUCCION.md:6–7 | revisión | — |

Compatibilidad con producción verificada solo con lecturas: 0 filas violan las nuevas restricciones (estados, negativos, odómetro, firmas).

**Infraestructura de pruebas (encontrado al re-ejecutar):** (1) el runner terminaba con código 0 aunque fallaran suites, porque `async-exit-hook` (dependencia de embedded-postgres) llama `process.exit(0)` y pisaba `process.exitCode` → salida explícita (tests/qa/run-isolated.mjs:48–52). (2) Un fallo a mitad de E2E dejaba Edge Functions vivas y la siguiente ejecución probaba **código viejo** en esos puertos → limpieza al salir y aborto si el puerto está ocupado (tests/e2e/run.mjs:47–56). Sin estas dos correcciones los resultados verdes no eran fiables.

**Pendiente:** DAT-01 (CSV 4 vehículos/13 personas vs JSON 8/29) sin decidir fuente vigente; cobertura porcentual no medida; conciliación de incentivos contra operación real.

---
## Informe original de Codex (reproducción previa a la corrección)
## Dictamen: requiere correcciones
11 casos de código/datos: 8 aprobados y 3 fallidos. Sintaxis de 16 JS aprobada. Las 4 funciones pasan Deno check. Las 6 pruebas unitarias Edge existentes pasan. Evidencias: [code-data.json](evidencias/code-data.json), [typecheck.log](evidencias/typecheck.log), [edge.log](evidencias/edge.log).

| ID | Severidad | Reproducción y resultado | Fuente | Corrección solicitada a Claude |
|---|---|---|---|---|
| COD-04 | Alta | Cliente con crédito bloqueado, promesa de pago y dirección dudosa/lat=null: validar() devuelve elegible | public/js/app.js:81–83 | Validar crédito, dirección y mínimo como condiciones independientes; promesa solo debe resolver crédito |
| COD-05 | Alta | Cliente con crédito bloqueado y promesa, pedido B/.1: devuelve elegible aunque mínimo es 40 | public/js/app.js:81–85 | Reutilizar validación independiente y probar complementos/monto límite |
| COD-06 | Media | Reloj 2026-10-10T02:00Z: hoy() devuelve 10-oct aunque Panamá está en 9-oct 21:00 | public/js/app.js:7 | Definir zona operativa America/Panama y usarla en fechas, semana y horas; evitar depender de zona del teléfono |
| DAT-02 | Alta | API de admin acepta cantidad_cajas=-1 y precio=-5 (HTTP 201) | supabase/schema.sql:65–68; evidencias/e2e/qa-extended.json | Validaciones servidor y constraints para cantidades/precios/capacidades; confirmar casos de devoluciones legítimas |
| DAT-03 | Media | UPDATE de ruta a QA_ESTADO_IMPOSIBLE aceptado en base aislada | supabase/schema.sql:74; evidencias/sql-audit.json | Restringir dominio de estados y transiciones según actor |

Los ensayos validar() invocan la función original con almacenamiento simulado para aislar su lógica; no son pruebas de interfaz o base. El reloj fijo es un caso determinista. Las otras dos pruebas usan PostgreSQL real.

## Aprobado
Capacidades exactas y excesos de cajas/peso/volumen; sumas independientes; semana ISO de cambio de año; tramos de bono y sin dato; mínimo y complemento de facturas; claves/referencias JSON; totales de cajas/peso/volumen de los 40 pedidos coinciden con 116 líneas. Revisión CSV anterior: sin duplicados en claves revisadas ni referencias huérfanas.

## Infraestructura corregida para medir
COD-01 resuelto: runner SQL ya propaga errores; probado con SQL deliberadamente inválido. COD-02 resuelto para entorno local: herramientas declaradas, conexión QA exclusiva, eliminación de su postgres y ruta /opt fija. Se corrigió además resolución de rutas con espacios (fileURLToPath), una aserción siempre verdadera y el OR redundante de incentivos; pageerror inesperado hace fallar la suite. No se cambió código productivo.

## Pendiente
DAT-01: CSV tiene 4 vehículos/13 personas frente a 8/29 en JSON; Claude debe documentar fuente vigente o regenerar. COD-03: guía de despliegue desactualizada sobre main/demo v2. Los tests de bono ejercitan umbrales; falta conciliación exhaustiva de todos los indicadores, correcciones manuales y bonos semanales contra operación real. No se midió cobertura porcentual. No se certifica ausencia de otros defectos.
