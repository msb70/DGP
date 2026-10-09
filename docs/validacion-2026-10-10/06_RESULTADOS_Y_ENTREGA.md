# Resultado de la ejecución y entrega a Claude
Fecha: 10 de octubre de 2026 · Base af5e998, rama main + cambios de infraestructura de pruebas. Entorno macOS arm64, PostgreSQL 16.14 local en 127.0.0.1:55439, Node 22.23.2 y Deno 2.9.6.

## Re-ejecución tras las correcciones (Claude · 10-oct-2026)
Entorno de la re-ejecución: Linux x64, PostgreSQL embebido 16.14 en 127.0.0.1:55439 (mismo runner `npm run test:qa`), Node 22, Deno 2.9.6, Playwright 1.64 (Chromium/Firefox/WebKit). Rama `qa-correcciones` sobre `main` 892da4f. **Emulador local**: PostgreSQL real con RLS, Auth/PostgREST emulados, Meta y Zoho simulados. No es staging ni proveedor real.

**Resultado: los 12 casos fallidos ahora aprueban; 0 regresiones.** `npm run test:qa` termina con código 0: código/datos 11/11 · Edge 6/6 · typecheck 4/4 · RLS original OK · SQL adicional 9/9 · E2E 36/36 (incluye Firefox y WebKit). Se añadieron 6 regresiones nuevas (5 SQL de escrituras del conductor, 1 de reconciliación Zoho). Detalle por hallazgo en los informes 01–04.

**No significa aprobación de producción.** Falta: (1) aplicar la migración 10b de `supabase/v3_produccion.sql` y desplegar la función `zoho` y la web; (2) re-probar en **staging Supabase** (no hay staging hoy: solo el proyecto productivo); (3) pruebas con cuentas de prueba reales de Meta y Zoho; (4) dispositivos físicos; (5) decisiones de DGP sobre alcance de lectura por rol y ventana offline de 72 h.

Cambios fuera del código productivo: el runner devolvía 0 con fallos y podía probar Edge Functions viejas; ambos corregidos (informe 01). Se ajustaron dos fixtures de prueba por realismo (paquete nuevo en la prueba de concurrencia Zoho; pedido en ruta = `planificado`), documentado en 02 y 03. Ninguna aserción se relajó.

---
## Entrega original de Codex

## Resultado
**No aprobar para producción.** 55 casos contabilizados: 43 aprobados, 12 fallidos (6 Edge + 11 código/datos + 4 SQL adicionales + 34 navegador). Además, suite RLS original y chequeos TypeScript aprobados. 25/25 escenarios originales de navegador pasan; los casos nuevos encuentran defectos que aquellos no cubrían.

Hay 12 casos fallidos, no necesariamente 12 causas independientes: firmas/RLS y XSS están relacionados; las dos fallas de elegibilidad comparten rama de código. Conservar esa distinción al corregir.

Prioridad 1: SEG-06 XSS por firma y SEG-01/05 mutación de verificación/liberación por conductor. Prioridad 2: FUN-05/06 duplicados de Zoho/eventos, FUN-07 arranque offline y COD-04/05 elegibilidad. Prioridad 3: REN-01 truncamiento, DAT-02 negativos, DAT-03 estados y COD-06 zona operativa. Revisar además alcance de lectura de ejecutivo/ayudante y coherencia CSV/JSON.

## Qué cambió
Solo infraestructura y pruebas: dependencias dev fijadas, PostgreSQL embebido aislado, SQL client QA, runners portables, casos adicionales, aserciones fiables y evidencias. No se corrigieron defectos productivos, para que Claude reciba reproducción intacta. No se publicó, no se hizo commit/push y no se tocó Supabase real, Meta o Zoho comerciales.

## Cómo reproducir
Desde la raíz:
```sh
npm ci --prefix tests
npm exec --prefix tests -- playwright install chromium firefox webkit
npm run test:qa --prefix tests
```
El último comando retorna código 1 mientras existan estas regresiones. Crea un cluster nuevo en tests/qa/.runtime (ignorado por git), vinculado únicamente a 127.0.0.1:55439, y bases dgp_test/dgp_e2e. Detiene el servidor al finalizar; conserva archivos locales del cluster QA. No apunta al proyecto Supabase de config.js: el servidor de pruebas sustituye esa configuración. Se necesitan puertos locales 55439,54321,8080,8201–8204 libres. Las credenciales de los ensayos son sintéticas.

El código fuente base af5e998 no se ha commiteado con estos cambios; Claude debe tomar el checkout y los archivos de tests adjuntos. Los informes hacen referencia a líneas de fuente productiva que quedó sin cambios. evidencias/provenance.json contiene hashes.

## Alcance pendiente del plan
La ejecución local cubrió las cuatro áreas y produjo evidencia, pero **no completa todos los casos del plan**. Carga sostenida, métricas frontend/CPU, matriz completa de mutaciones, dispositivos físicos, auditoría exhaustiva y staging/proveedores reales siguen pendientes, listados por informe. No se verificó despliegue público ni cuentas reales de prueba. No conceder aprobación final mientras existan defectos críticos/altos y casos críticos pendientes.

## Entregables
00_PLAN_VALIDACION.md: plan original y actualización de ejecución.
01–04: resultados por área, evidencia y correcciones solicitadas.
05_ENTREGA_A_CLAUDE.md: encargo de corrección/regresión.
evidencias/: logs, resultados JSON, matrices, planes SQL y capturas.
