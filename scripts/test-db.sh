#!/usr/bin/env bash
# Applies every migration in supabase/migrations to a DISPOSABLE Postgres database
# and runs the SQL tests in supabase/tests against it.
#
# Usage:
#   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:db
#   npm run test:db            # no URL: starts a throwaway local cluster (needs initdb)
#
# Never point TEST_DATABASE_URL at a real Supabase project: the database is wiped.
set -euo pipefail
shopt -s nullglob

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS="$ROOT/supabase/migrations"
TESTS="$ROOT/tests/db"
TMP_CLUSTER=""
PG_BIN=""
RUN_AS=()

cleanup() {
  if [[ -n "$TMP_CLUSTER" ]]; then
    "${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$TMP_CLUSTER/data" -m immediate stop >/dev/null 2>&1 || true
    rm -rf "$TMP_CLUSTER"
  fi
}
trap cleanup EXIT

if [[ -z "${TEST_DATABASE_URL:-}" ]]; then
  PG_BIN="$(dirname "$(command -v initdb 2>/dev/null || ls -d /usr/lib/postgresql/*/bin/initdb 2>/dev/null | sort -V | tail -1)")"
  if [[ ! -x "$PG_BIN/initdb" ]]; then
    echo "No TEST_DATABASE_URL and no local initdb found. Set TEST_DATABASE_URL to a disposable database." >&2
    exit 1
  fi
  TMP_CLUSTER="$(mktemp -d)"
  PORT="${TEST_DB_PORT:-54329}"
  if [[ "$(id -u)" == "0" ]]; then
    # Postgres refuses to run as root; use the unprivileged postgres account.
    chown -R postgres "$TMP_CLUSTER"
    RUN_AS=(runuser -u postgres --)
  fi
  "${RUN_AS[@]}" "$PG_BIN/initdb" -D "$TMP_CLUSTER/data" -U postgres --auth=trust >/dev/null
  "${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$TMP_CLUSTER/data" -o "-p $PORT -k $TMP_CLUSTER -c listen_addresses=''" -w start >/dev/null
  TEST_DATABASE_URL="postgresql://postgres@/postgres?host=$TMP_CLUSTER&port=$PORT"
fi

PSQL=(psql "$TEST_DATABASE_URL" -X -q -v ON_ERROR_STOP=1)

echo "==> Resetting test database"
"${PSQL[@]}" -c "drop schema if exists public cascade; create schema public; drop schema if exists auth cascade;"

echo "==> Installing Supabase compatibility shim"
"${PSQL[@]}" -f "$TESTS/00_supabase_shim.sql"

for f in "$MIGRATIONS"/*.sql; do
  echo "==> Applying migration $(basename "$f")"
  "${PSQL[@]}" -f "$f"
done

for f in "$TESTS"/[1-9]*.sql; do
  echo "==> Running $(basename "$f")"
  # Query results are discarded; assertion notices ("ok - ...") are printed.
  "${PSQL[@]}" -o /dev/null -f "$f" 2>&1 | sed -E 's/^psql:[^ ]+ NOTICE:  /  /' 
done

echo "==> Database tests passed"
