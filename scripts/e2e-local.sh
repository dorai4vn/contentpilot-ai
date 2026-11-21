#!/usr/bin/env bash
# Runs the browser E2E suites against a FRESH local build of the app and the LOCAL
# Supabase stack, in a standard environment:
#
#   npx supabase start           # Docker; see CLAUDE.md for the cloud-session flags
#   npm run test:e2e:local                       # all suites
#   npm run test:e2e:local -- content agent-ui   # some suites
#
# - Refuses anything that is not localhost / 127.0.0.1 (never production or a preview).
# - Builds the app with the LOCAL Supabase URL and key (they override .env.local).
# - Starts its own `next start` on a free port and stops exactly that process at
#   the end; it never reuses or depends on a server that is already running.
# - OpenAI: a dummy key and model so the agent page shows the chat, and
#   OPENAI_BASE_URL pointing to a closed local port, so even an accidental
#   server-side call cannot reach OpenAI. (agent-ui intercepts /api/agent in the
#   browser anyway.) No real key is read or needed.
# - SKIP_BUILD=1 reuses an existing .next build; E2E_PORT picks the port (default 3100).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

SUITES=("$@")
if [[ ${#SUITES[@]} -eq 0 ]]; then SUITES=(smoke content agent-ui approval-ui); fi
PORT="${E2E_PORT:-3100}"
LOCAL_RE='^(https?://|postgres(ql)?://[^@]*@)(localhost|127\.0\.0\.1)(:[0-9]+)?(/|$)'

status="$(npx supabase status -o env 2>/dev/null)" || {
  echo "Local Supabase is not running. Start it with: npx supabase start" >&2
  exit 1
}
value() { printf '%s\n' "$status" | sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" | head -n1; }
SUPABASE_URL="$(value API_URL)"
SUPABASE_KEY="$(value PUBLISHABLE_KEY)"
SUPABASE_KEY="${SUPABASE_KEY:-$(value ANON_KEY)}"
DB_URL="$(value DB_URL)"
BASE_URL="http://127.0.0.1:${PORT}"

for url in "$SUPABASE_URL" "$DB_URL" "$BASE_URL"; do
  if ! [[ "$url" =~ $LOCAL_RE ]]; then
    echo "Refusing to run: every target must be localhost / 127.0.0.1." >&2
    exit 2
  fi
done
if [[ -z "$SUPABASE_KEY" ]]; then
  echo "Refusing to run: no local Supabase publishable/anon key found." >&2
  exit 2
fi
if (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
  echo "Port ${PORT} is already in use. Stop that process or set E2E_PORT." >&2
  exit 1
fi

# Standard app environment (process env takes precedence over .env.local).
export NEXT_PUBLIC_SUPABASE_URL="$SUPABASE_URL"
export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$SUPABASE_KEY"
export OPENAI_API_KEY="sk-test-local-dummy-00000000000000000000"
export OPENAI_MODEL="test-model"
export OPENAI_BASE_URL="http://127.0.0.1:9/v1"

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> Building the app against the local Supabase stack"
  npx next build >/dev/null
fi

LOG="$(mktemp)"
echo "==> Starting the app on ${BASE_URL}"
setsid node node_modules/next/dist/bin/next start -p "$PORT" -H 127.0.0.1 >"$LOG" 2>&1 &
SERVER_PID=$!
cleanup() {
  kill -- "-${SERVER_PID}" 2>/dev/null || kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  rm -f "$LOG"
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "${BASE_URL}/api/health"; then break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "The app failed to start:" >&2
    tail -20 "$LOG" >&2
    exit 1
  fi
  sleep 1
done
curl -fsS -o /dev/null "${BASE_URL}/api/health" || { echo "The app did not become healthy." >&2; exit 1; }

export BASE_URL
export LOCAL_DB_URL="$DB_URL"
failed=()
for suite in "${SUITES[@]}"; do
  file="tests/e2e/${suite}.cjs"
  [[ -f "$file" ]] || { echo "Unknown suite: ${suite}" >&2; exit 2; }
  echo "==> E2E ${suite}"
  if ! node "$file"; then failed+=("$suite"); fi
done

if [[ ${#failed[@]} -gt 0 ]]; then
  echo "==> Failed suites: ${failed[*]}" >&2
  exit 1
fi
echo "==> All E2E suites passed: ${SUITES[*]}"
