# Validación DGP

## Ejecución reproducible y aislada (10-oct-2026)
Desde la raíz del repositorio:
```sh
npm ci --prefix tests
npm exec --prefix tests -- playwright install chromium firefox webkit
npm run test:qa --prefix tests
```
Requiere Node 22 y puertos localhost 55439, 54321, 8080, 8201–8204 libres. Deno 2.9.6, PostgreSQL 16.14 embebido y Playwright 1.64.0 se instalan como dependencias dev. El cluster se crea nuevo, escucha solo 127.0.0.1 y se detiene al finalizar. Sus archivos quedan en qa/.runtime, ignorados por git. No se usa config.js productivo ni Supabase real.

El comando devuelve código 1 cuando hay pruebas fallidas. En la ejecución documentada se reprodujeron regresiones; no cambiar expectativas para hacerlas pasar. Los runners SQL/E2E directos necesitan el cluster y entorno que provee run-isolated.mjs; no ejecutarlos contra una base operativa.

| Suite | Cobertura |
|---|---|
| qa/code-data.mjs | Sintaxis, capacidad, totales, semana/bono, elegibilidad, zona operativa e integridad semilla |
| edge/funciones_test.ts | 6 pruebas puras de Zoho/WhatsApp |
| Deno check | Cuatro funciones Edge |
| sql/10_rls_test.sql | Roles, anon, auditoría, último admin, rutas, avisos y saneamiento |
| qa/sql-audit.mjs | 495 lecturas por rol, bloqueo anon, confiabilidad runner, estados y planes de 25.000 pedidos/100.000 eventos |
| e2e/run.mjs | 25 escenarios originales de operación sobre emulador Auth/PostgREST, RLS real, Edge reales y Meta/Zoho simulados |
| qa/extended-e2e.mjs | 7 regresiones de seguridad/datos/offline/concurrencia/volumen y 2 smoke tests Firefox/WebKit; ráfagas REST |

Resultados en docs/validacion-2026-10-10/evidencias. Leer los cuatro informes para límites y pendientes. El emulador no sustituye Supabase staging. GPS se simula, servicios de mapa se bloquean y proveedor comercial no recibe llamadas.
