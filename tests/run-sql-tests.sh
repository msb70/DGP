#!/usr/bin/env bash
# Pruebas de seguridad en una base local nueva: esquema v2 + datos + migración v3 (dos veces, idempotente) + pruebas RLS.
set -euo pipefail
cd "$(dirname "$0")/.."
DB=${DB:-dgp_test}
P="su postgres -c"
$P "dropdb --if-exists $DB && createdb $DB"
for f in tests/sql/00_supabase_emul.sql supabase/dgp_mvp_completo.sql supabase/v3_produccion.sql supabase/v3_produccion.sql tests/sql/10_rls_test.sql; do
  $P "psql -q -v ON_ERROR_STOP=1 -d $DB -f $f" 2>&1 | grep -vE "NOTICE|^ como|^---|^\s*$|\(1 row\)|wal_level|HINT" || true
done
