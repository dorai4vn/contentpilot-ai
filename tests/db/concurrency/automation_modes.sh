#!/usr/bin/env bash
# FN08 concurrency: parallel auto claims never exceed the daily quota, and a concurrent switch to Off
# leaves nothing claimable afterwards. Runs against the disposable database of scripts/test-db.sh
# (after tests/db/90_automation_modes.sql, which leaves the project Off).
set -euo pipefail
: "${TEST_DATABASE_URL:?}"
WS=6c000000-0000-0000-0000-000000000001
PROJECT=6c100000-0000-0000-0000-000000000001
CHANNEL=60000000-0000-4000-8000-000000000080
WORKER=00000000-0000-0000-0000-0000000006c3
OWNER=00000000-0000-0000-0000-0000000006c1
q() { psql "$TEST_DATABASE_URL" -X -q -At -v ON_ERROR_STOP=1 "$@"; }
as() { printf "set role authenticated;\nselect set_config('request.jwt.claim.sub','%s',false);\n" "$1"; }
today() { q -c "select count(*) from contentpilot_private.sports_auto_publish_deliveries where (started_at at time zone 'Asia/Dubai')::date=(clock_timestamp() at time zone 'Asia/Dubai')::date"; }
draft() {
  q -o /dev/null <<SQL
$(as $WORKER)
select public.record_sports_news_assessment('$WS','$PROJECT','https://conc.example/$1',encode(sha256(convert_to('conc-$1','UTF8')),'hex'),9,'Conc $1','Caption',null,'T',
  array['$CHANNEL'::uuid], jsonb_build_object('publishedAt',clock_timestamp(),'rubricVersion','sports-v1','decision','threshold_met'));
SQL
}
claim() {
  q <<SQL
$(as $WORKER)
select count(*) from public.claim_sports_auto_publish('$WS','$PROJECT','$CHANNEL',(select post_id from public.sports_news_items where source_url='https://conc.example/$1'));
SQL
}
setmode() {
  q -o /dev/null <<SQL
$(as $OWNER)
select public.set_sports_automation_mode('$WS','$PROJECT','$CHANNEL','$1',$2,${3:-null},${4:-null});
SQL
}

N=8
# Earlier fixtures used the current 2h slot (cap = posts per scan): move them out of it.
q -c "update contentpilot_private.sports_auto_publish_deliveries set slot = slot + 1000000"
BASE=$(today)
setmode auto $((BASE + 3)) 2 3
for i in $(seq 1 $N); do draft $i; done
OUT=$(mktemp -d)
for i in $(seq 1 $N); do ( claim $i > "$OUT/$i" ) & done
wait
GOT=$(cat "$OUT"/* | grep -c '^1$' || true)
if [[ "$GOT" != "3" || "$(today)" != "$((BASE + 3))" ]]; then
  echo "ASSERTION FAILED: $N concurrent claims with 3 quota left claimed $GOT (deliveries today $(today), base $BASE)" >&2
  exit 1
fi
echo "  ok - $N concurrent auto claims never exceed the daily quota (3)"

# Mode switch racing with claims: after the switch to Off commits, nothing is claimable.
setmode auto 120 2 3
for i in $(seq 21 $((20 + N))); do draft $i; done
rm -f "$OUT"/*
for i in $(seq 21 $((20 + N))); do ( claim $i > "$OUT/$i" ) & done
( setmode off 120 ) &
wait
draft 99 2>/dev/null && echo "ASSERTION FAILED: draft stored while Off" >&2 && exit 1
OPEN=$(q -c "select count(*) from contentpilot_private.sports_auto_publish_windows where persistent and ends_at > clock_timestamp()")
AFTER=$(q <<SQL
$(as $WORKER)
select count(*) from public.claim_sports_auto_publish('$WS','$PROJECT','$CHANNEL',(select post_id from public.sports_news_items where source_url='https://conc.example/21'));
SQL
)
AFTER=$(printf '%s\n' "$AFTER" | tail -1)
DUP=$(q -c "select count(*) from (select request_id from contentpilot_private.sports_auto_publish_deliveries group by request_id having count(*)>1) d")
if [[ "$OPEN" != "0" || "$AFTER" != "0" || "$DUP" != "0" ]]; then
  echo "ASSERTION FAILED: after concurrent Off open=$OPEN claim_after=$AFTER duplicates=$DUP" >&2
  exit 1
fi
echo "  ok - concurrent switch to Off leaves no open window, no claim and no duplicate delivery"
setmode semi 40

# FN09 scan gate: of N concurrent scheduler ticks exactly one scan is due; none while Off.
scan() { q <<SQL
$(as $WORKER)
select due from public.begin_sports_scan('$WS','$PROJECT');
SQL
}
setmode semi 40 2 2
q -c "update contentpilot_private.sports_automation_modes set last_scan_at = null where project_id='$PROJECT'"
mkdir -p "$OUT"; rm -f "$OUT"/*
for i in $(seq 1 $N); do ( scan | tail -1 > "$OUT/s$i" ) & done
wait
DUE=$(cat "$OUT"/s* | grep -c '^t$' || true)
if [[ "$DUE" != "1" ]]; then echo "ASSERTION FAILED: $N concurrent ticks produced $DUE scans (expected exactly 1)" >&2; exit 1; fi
echo "  ok - $N concurrent scheduler ticks start exactly one scan"
setmode off 40 2 2
if [[ "$(scan | tail -1)" != "f" ]]; then echo "ASSERTION FAILED: scan due while Off" >&2; exit 1; fi
echo "  ok - no scan is due while Off"
# FN09-QC-B: simultaneous claims while the interval is changed up and down never exceed posts-per-scan (stable scan
# identity), and the daily cap still holds.
BASE=$(today)
setmode auto $((BASE + 20)) 2 2
q -c "update contentpilot_private.sports_automation_modes set last_scan_at = null, scan_status = 'done', scan_retries = 0 where project_id='$PROJECT'"
if [[ "$(scan | tail -1)" != "t" ]]; then echo "ASSERTION FAILED: scan did not open" >&2; exit 1; fi
for i in $(seq 51 $((50 + N))); do draft $i; done
rm -f "$OUT"/*
for i in $(seq 51 $((50 + N))); do ( claim $i > "$OUT/$i" ) & done
( for iv in 6 4 24 2 12 2; do setmode auto $((BASE + 20)) $iv 2; done ) &
wait
GOT=$(cat "$OUT"/* | grep -c '^1$' || true)
if [[ "$GOT" != "2" ]]; then echo "ASSERTION FAILED: $N concurrent claims during interval changes claimed $GOT (expected exactly posts-per-scan 2)" >&2; exit 1; fi
echo "  ok - concurrent claims during interval changes never exceed posts per scan (2)"

# FN09-QC-C: of N concurrent ticks after a failed scan exactly one retry is granted, and a retry is bounded.
q -c "update contentpilot_private.sports_automation_modes set scan_interval_hours = 6, scan_status = 'failed', scan_retries = 0, last_scan_at = clock_timestamp() - interval '2 hours' where project_id='$PROJECT'"
rm -f "$OUT"/*
for i in $(seq 1 $N); do ( q <<SQL | tail -1 > "$OUT/r$i"
$(as $WORKER)
select due and is_retry from public.begin_sports_scan('$WS','$PROJECT');
SQL
) & done
wait
RETRY=$(cat "$OUT"/r* | grep -c '^t$' || true)
if [[ "$RETRY" != "1" ]]; then echo "ASSERTION FAILED: $N concurrent ticks granted $RETRY retries (expected exactly 1)" >&2; exit 1; fi
echo "  ok - concurrent ticks after a failed scan grant exactly one retry"
setmode auto $((BASE + 20)) 2 2
setmode semi 40 2 2   # leave Semi for the next concurrency test, as before
rm -rf "$OUT"
