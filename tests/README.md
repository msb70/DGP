# Pruebas de la v3

| Suite | Qué cubre | Cómo |
|---|---|---|
| `sql/10_rls_test.sql` | RLS por rol, anon sin acceso, auto-registro sin privilegios, auditoría inmutable y sellada, último admin, conductor limitado a sus rutas, preparación de WhatsApp, HTML inyectado | `bash tests/run-sql-tests.sh` (Postgres 16 local) |
| `edge/funciones_test.ts` | Mapeo Zoho (clientes, artículos, pedidos, paquete verificado) y payload de WhatsApp | `deno test tests/edge` |
| `e2e/run.mjs` | 25 escenarios en navegador con base real + RLS, Edge Functions reales en Deno, Meta y Zoho simulados | `cd tests && npm i && cd .. && DENO=$(which deno) node tests/e2e/run.mjs` |

`e2e/mock-supabase.mjs` emula PostgREST y GoTrue sobre Postgres local ejecutando cada consulta con `SET ROLE` y `request.jwt.claims`, así que las políticas RLS reales deciden. No se usa en producción.
