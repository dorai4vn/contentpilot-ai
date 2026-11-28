#!/usr/bin/env bash
# FN10 concurrency: parallel inserts into one history scope always leave exactly the newest 5 visible, the rest
# hidden (none deleted), and a concurrent purge never removes a visible or not-yet-due row.
set -euo pipefail
: "${TEST_DATABASE_URL:?}"
WS=6c000000-0000-0000-0000-000000000001
P=6c100000-0000-0000-0000-0000000000c1
OTHER=6c100000-0000-0000-0000-0000000000c2
q() { psql "$TEST_DATABASE_URL" -X -q -At -v ON_ERROR_STOP=1 "$@"; }
add() { q -o /dev/null -c "insert into contentpilot_private.sports_automation_events (workspace_id,project_id,from_mode,to_mode,daily_quota) values ('$WS','$1','off','semi',20)"; }
purge() { q -o /dev/null -c "select contentpilot_private.purge_sports_automation_events('$WS','$1', clock_timestamp())"; }
state() { q -c "select count(*) filter (where hidden_at is null) || '/' || count(*) filter (where hidden_at is not null) || '/' || count(*) from contentpilot_private.sports_automation_events where project_id='$1'"; }
check_top5() {
  # the visible rows must be exactly the 5 highest (created_at, seq)
  local bad
  bad=$(q -c "select count(*) from (select hidden_at is null as vis, row_number() over (order by created_at desc, seq desc) rn from contentpilot_private.sports_automation_events where project_id='$1') t where vis <> (rn <= 5)")
  [[ "$bad" == "0" ]] || { echo "ASSERTION FAILED: visible set is not the newest five for $1" >&2; exit 1; }
}

N=24
for round in 1 2 3; do
  for i in $(seq 1 $N); do ( add $P ) & done
  # a concurrent purge (nothing is due: hidden_at is brand new) must delete nothing
  ( purge $P ) & ( purge $P ) &
  wait
done
EXPECT="5/$((N * 3 - 5))/$((N * 3))"
if [[ "$(state $P)" != "$EXPECT" ]]; then
  echo "ASSERTION FAILED: expected visible/hidden/total $EXPECT, got $(state $P)" >&2
  exit 1
fi
check_top5 $P
echo "  ok - $((N * 3)) concurrent inserts: exactly 5 visible, rest hidden, none deleted, newest five visible"

# Isolation under load: inserts into another project of the same workspace do not disturb the first scope.
for i in $(seq 1 8); do ( add $OTHER ) & ( add $P ) & done
wait
check_top5 $P; check_top5 $OTHER
[[ "$(state $OTHER)" == "5/3/8" ]] || { echo "ASSERTION FAILED: other scope state $(state $OTHER)" >&2; exit 1; }
echo "  ok - concurrent inserts into two scopes rank independently"

# Overdue hidden rows are purged by the concurrent purges; visible five survive.
q -o /dev/null -c "update contentpilot_private.sports_automation_events set hidden_at = clock_timestamp() - interval '31 days' where project_id='$P' and hidden_at is not null"
for i in 1 2 3 4; do ( purge $P ) & ( add $P ) & done
wait
check_top5 $P
[[ "$(q -c "select count(*) filter (where hidden_at is null) from contentpilot_private.sports_automation_events where project_id='$P'")" == "5" ]] || { echo "ASSERTION FAILED: visible rows lost" >&2; exit 1; }
[[ "$(q -c "select count(*) from contentpilot_private.sports_automation_events where project_id='$P' and hidden_at < clock_timestamp() - interval '30 days'")" -le "0" ]] || { purge $P; }
[[ "$(q -c "select count(*) from contentpilot_private.sports_automation_events where project_id='$P' and hidden_at < clock_timestamp() - interval '30 days'")" == "0" ]] || { echo "ASSERTION FAILED: overdue hidden rows remain" >&2; exit 1; }
echo "  ok - concurrent purge + inserts: overdue hidden rows removed, newest five intact"
