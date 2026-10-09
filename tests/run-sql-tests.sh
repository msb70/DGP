#!/usr/bin/env bash
# Pruebas de seguridad en una base local nueva: esquema v2 + datos + migración v3 (dos veces, idempotente) + pruebas RLS.
set -euo pipefail
cd "$(dirname "$0")/.."
DB=dgp_test
node tests/qa/pg-cli.mjs --reset "$DB"
for f in tests/sql/00_supabase_emul.sql supabase/dgp_mvp_completo.sql supabase/v3_produccion.sql supabase/v3_produccion.sql tests/sql/10_rls_test.sql; do
  node tests/qa/pg-cli.mjs -d "$DB" -f "$f"
done
