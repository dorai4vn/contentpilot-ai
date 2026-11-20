#!/usr/bin/env bash
# Runs the agent integration tests against the LOCAL Supabase stack only.
#
#   npx supabase start          # Docker; see CLAUDE.md for the cloud-session flags
#   npm run test:integration
#
# Connection values come from `npx supabase status` (local, disposable) unless
# INTEGRATION_SUPABASE_URL / INTEGRATION_SUPABASE_KEY / LOCAL_DB_URL are set.
# The tests refuse to run if any of them is not localhost / 127.0.0.1.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ -z "${INTEGRATION_SUPABASE_URL:-}" || -z "${INTEGRATION_SUPABASE_KEY:-}" || -z "${LOCAL_DB_URL:-}" ]]; then
  if ! status="$(npx supabase status -o env 2>/dev/null)"; then
    echo "Local Supabase is not running. Start it with: npx supabase start" >&2
    exit 1
  fi
  value() { printf '%s\n' "$status" | sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" | head -n1; }
  export INTEGRATION_SUPABASE_URL="${INTEGRATION_SUPABASE_URL:-$(value API_URL)}"
  key="$(value PUBLISHABLE_KEY)"
  export INTEGRATION_SUPABASE_KEY="${INTEGRATION_SUPABASE_KEY:-${key:-$(value ANON_KEY)}}"
  export LOCAL_DB_URL="${LOCAL_DB_URL:-$(value DB_URL)}"
fi

exec npx vitest run --config vitest.integration.config.mts "$@"
