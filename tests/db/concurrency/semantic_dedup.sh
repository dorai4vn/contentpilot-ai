#!/usr/bin/env bash
# FN05 concurrency: N parallel sessions report the SAME real-world event through different URLs/headlines.
# Exactly one item/post may be created. Runs against the disposable database of scripts/test-db.sh.
set -euo pipefail
: "${TEST_DATABASE_URL:?}"
N=8
WS=6c000000-0000-0000-0000-000000000001
PROJECT=6c100000-0000-0000-0000-000000000001
WORKER=00000000-0000-0000-0000-0000000006c3
KEY=$(printf 'f%.0s' $(seq 64))
CLUSTER=$(printf '1%.0s' $(seq 64))
EVENT="{\"decision\":\"new\",\"eventKey\":\"$KEY\",\"clusterKey\":\"$CLUSTER\",\"identity\":{\"version\":\"event-v1\"},\"reasons\":[]}"

for i in $(seq 1 $N); do
  (
    # Different cluster key variants per session would be caught by the exact key; use distinct event keys
    # on odd sessions to exercise the cluster guard as well.
    if (( i % 2 )); then K=$KEY; else K=$(printf "%064x" "$i"); fi
    E="{\"decision\":\"new\",\"eventKey\":\"$K\",\"clusterKey\":\"$CLUSTER\",\"identity\":{\"version\":\"event-v1\"},\"reasons\":[]}"
    psql "$TEST_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -o /dev/null <<SQL
set role authenticated;
select set_config('request.jwt.claim.sub', '$WORKER', false);
select public.record_sports_news_event_assessment('$WS', '$PROJECT', 'https://race.example/$i', '$(printf "%064x" $((1000+i)))',
  8, 'Race $i', 'Caption', null, 'RSS', array[]::uuid[], '{}'::jsonb, '$E'::jsonb);
SQL
  ) &
done
wait

COUNT=$(psql "$TEST_DATABASE_URL" -X -At -c "select count(*) from public.sports_news_items where project_id='$PROJECT' and cluster_key='$CLUSTER'")
POSTS=$(psql "$TEST_DATABASE_URL" -X -At -c "select count(*) from public.content_posts where title like 'Race %'")
if [[ "$COUNT" != "1" || "$POSTS" != "1" ]]; then
  echo "ASSERTION FAILED: expected exactly 1 item and 1 post for $N concurrent reports, got items=$COUNT posts=$POSTS" >&2
  exit 1
fi
echo "  ok - $N concurrent reports of one event create exactly one item and one post"
