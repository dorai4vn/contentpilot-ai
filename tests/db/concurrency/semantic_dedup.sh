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
EVENT="{\"decision\":\"new\",\"specific\":true,\"eventKey\":\"$KEY\",\"clusterKey\":\"$CLUSTER\",\"identity\":{\"version\":\"event-v1\"},\"reasons\":[]}"

for i in $(seq 1 $N); do
  (
    # Different cluster key variants per session would be caught by the exact key; use distinct event keys
    # on odd sessions to exercise the cluster guard as well.
    if (( i % 2 )); then K=$KEY; else K=$(printf "%064x" "$i"); fi
    E="{\"decision\":\"new\",\"specific\":true,\"eventKey\":\"$K\",\"clusterKey\":\"$CLUSTER\",\"identity\":{\"version\":\"event-v1\"},\"reasons\":[]}"
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

# Low -> high under concurrency: interleaved low-score (no post) and high-score (post) reports of ONE event.
# Low-score reports never block; exactly one high-score report may create the post; every low report is recorded.
CLUSTER2=$(printf '3%.0s' $(seq 64))
for i in $(seq 1 $N); do
  (
    K=$(printf "%064x" $((5000+i)))
    E="{\"decision\":\"new\",\"specific\":true,\"eventKey\":\"$K\",\"clusterKey\":\"$CLUSTER2\",\"identity\":{\"version\":\"event-v2\"},\"reasons\":[]}"
    if (( i % 2 )); then TITLE="'Cao $i'"; else TITLE="null"; fi
    psql "$TEST_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -o /dev/null <<SQL
set role authenticated;
select set_config('request.jwt.claim.sub', '$WORKER', false);
select public.record_sports_news_event_assessment('$WS', '$PROJECT', 'https://lowhigh.example/$i', '$(printf "%064x" $((9000+i)))',
  case when $i % 2 = 1 then 8 else 2 end, $TITLE, case when $i % 2 = 1 then 'Caption' else null end, null, null, array[]::uuid[], '{}'::jsonb, '$E'::jsonb);
SQL
  ) &
done
wait
HIGH=$(psql "$TEST_DATABASE_URL" -X -At -c "select count(*) from public.sports_news_items where project_id='$PROJECT' and cluster_key='$CLUSTER2' and post_id is not null")
LOW=$(psql "$TEST_DATABASE_URL" -X -At -c "select count(*) from public.sports_news_items where project_id='$PROJECT' and cluster_key='$CLUSTER2' and post_id is null")
if [[ "$HIGH" != "1" || "$LOW" != "$((N / 2))" ]]; then
  echo "ASSERTION FAILED: low/high race expected 1 post-backed item and $((N / 2)) low items, got high=$HIGH low=$LOW" >&2
  exit 1
fi
echo "  ok - concurrent low-score and high-score reports: low ones never block, exactly one post is created"

# Concurrent DISTINCT events (different clusters) must all materialize: the project lock serializes, it never merges.
for i in $(seq 1 $N); do
  (
    K=$(printf "%064x" $((7000+i)))
    C=$(printf "%064x" $((8000+i)))
    E="{\"decision\":\"new\",\"specific\":true,\"eventKey\":\"$K\",\"clusterKey\":\"$C\",\"identity\":{\"version\":\"event-v4\"},\"reasons\":[]}"
    psql "$TEST_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -o /dev/null <<SQL
set role authenticated;
select set_config('request.jwt.claim.sub', '$WORKER', false);
select public.record_sports_news_event_assessment('$WS', '$PROJECT', 'https://distinct.example/$i', '$(printf "%064x" $((11000+i)))',
  8, 'Distinct $i', 'Caption', null, 'RSS', array[]::uuid[], '{}'::jsonb, '$E'::jsonb);
SQL
  ) &
done
wait
DISTINCT=$(psql "$TEST_DATABASE_URL" -X -At -c "select count(*) from public.content_posts where title like 'Distinct %'")
if [[ "$DISTINCT" != "$N" ]]; then
  echo "ASSERTION FAILED: expected $N posts for $N distinct concurrent events, got $DISTINCT" >&2
  exit 1
fi
echo "  ok - $N concurrent distinct events all materialize (no false merge under concurrency)"

# Same teams/date, DIFFERENT known competitions, reported concurrently: the competition is in the cluster key, so
# each competition's reports collapse to exactly one post and the two competitions both materialize.
CL_A=$(printf 'a%.0s' $(seq 64)); CL_B=$(printf 'b%.0s' $(seq 64))
for i in $(seq 1 $N); do
  (
    if (( i % 2 )); then C=$CL_A; NAME=Pl; else C=$CL_B; NAME=Eu; fi
    K=$(printf "%064x" $((20000+i)))
    E="{\"decision\":\"new\",\"specific\":true,\"eventKey\":\"$K\",\"clusterKey\":\"$C\",\"clusterWindow\":[\"$C\"],\"identity\":{\"version\":\"event-v4\"},\"reasons\":[]}"
    psql "$TEST_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -o /dev/null <<SQL
set role authenticated;
select set_config('request.jwt.claim.sub', '$WORKER', false);
select public.record_sports_news_event_assessment('$WS', '$PROJECT', 'https://comp.example/$i', '$(printf "%064x" $((21000+i)))',
  8, 'Comp $NAME $i', 'Caption', null, 'RSS', array[]::uuid[], '{}'::jsonb, '$E'::jsonb);
SQL
  ) &
done
wait
PL=$(psql "$TEST_DATABASE_URL" -X -At -c "select count(*) from public.content_posts where title like 'Comp Pl %'")
EU=$(psql "$TEST_DATABASE_URL" -X -At -c "select count(*) from public.content_posts where title like 'Comp Eu %'")
if [[ "$PL" != "1" || "$EU" != "1" ]]; then
  echo "ASSERTION FAILED: expected 1 post per competition, got premier=$PL europa=$EU" >&2
  exit 1
fi
echo "  ok - concurrent same-teams reports in two competitions: exactly one post per competition"
