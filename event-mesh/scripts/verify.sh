#!/usr/bin/env bash
# End-to-end verification against the LIVE deployment. The plank isn't done
# until every check here passes — including the failure paths: a poison
# message must actually land in a DLQ, get its bad-order card read, and come
# back out via operator redrive; the urgent workflow must show a real retry;
# the FIFO race must arrive in strict order with the duplicate absorbed; and
# an archive replay must run this suite's own events through the mesh again
# (which re-poisons a DLQ — the sweep at the end of section 9 cleans it up).
# Budget ~12-15 minutes; the replay and its cleanup dominate.
set -uo pipefail
cd "$(dirname "$0")/.."

TF="terraform -chdir=infra"
SITE=$($TF output -raw site_url)

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
check(){ if [ "$1" = "0" ]; then ok "$2"; else bad "$2"; fi }

# Poll a request's trace until a hop name appears (or timeout).
# usage: wait_hop <requestId> <hop> <tries> <sleep-seconds>
wait_hop() {
  local id=$1 hop=$2 tries=$3 pause=$4 i
  for i in $(seq 1 "$tries"); do
    TRACE=$(curl -sS "$SITE/api/requests/$id")
    echo "$TRACE" | jq -e --arg h "$hop" '.hops[] | select(.hop == $h)' > /dev/null && return 0
    sleep "$pause"
  done
  return 1
}

submit() { # usage: submit '<json-body>' -> sets REQ_ID
  REQ_ID=$(curl -sS -X POST "$SITE/api/requests" -H 'content-type: application/json' -d "$1" | jq -r '.requestId')
  [ -n "$REQ_ID" ] && [ "$REQ_ID" != "null" ]
}

echo "verifying $SITE"

# ---- 1. static site + security headers ----
HDRS=$(curl -sS -D - -o /tmp/evt-index.html "$SITE/" | tr -d '\r')
grep -q "Alpenglow Service Dispatch" /tmp/evt-index.html; check $? "site serves the service dispatch page"
echo "$HDRS" | grep -qi "strict-transport-security" || [ $? -eq 141 ]; check $? "HSTS header present"
echo "$HDRS" | grep -qi "content-security-policy" || [ $? -eq 141 ]; check $? "CSP header present"

# ---- 2. API surface ----
STATS=$(curl -sS "$SITE/api/stats")
echo "$STATS" | jq -e '.dlq.depths | has("roads") and has("utilities") and has("parks")' > /dev/null
check $? "stats endpoint reports all three DLQ depths"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/api/requests" \
  -H 'content-type: application/json' -d '{"category":"volcanoes","description":"not a department"}')
[ "$CODE" = "400" ]; check $? "invalid category is rejected (400)"

# ---- 3. routing + pub/sub fan-out (normal roads request) ----
submit '{"category":"roads","priority":"normal","description":"verify: pothole on Larkspur Ave","simulate":"none"}'
check $? "roads request accepted (id $REQ_ID)"
wait_hop "$REQ_ID" processed 20 2;    check $? "routed to the roads queue and processed by the worker"
wait_hop "$REQ_ID" notified 10 2;     check $? "SNS fan-out reached the Lambda notifier"
wait_hop "$REQ_ID" audit-logged 10 2; check $? "SNS fan-out reached the SQS audit subscriber"
echo "$TRACE" | jq -e '.hops[] | select(.hop == "processed") | select(.actor == "roads")' > /dev/null
check $? "trace shows the roads department worker (content-based routing)"
echo "$TRACE" | jq -e '[.hops[].hop] | contains(["sfn-triage"]) | not' > /dev/null
check $? "normal priority did NOT trigger the escalation workflow"

# ---- 4. routing correctness for a second category ----
submit '{"category":"utilities","priority":"normal","description":"verify: water main seep on Alder Ct","simulate":"none"}'
check $? "utilities request accepted"
wait_hop "$REQ_ID" processed 20 2
echo "$TRACE" | jq -e '.hops[] | select(.hop == "processed") | select(.actor == "utilities")' > /dev/null
check $? "utilities request routed to the utilities worker, not roads"

# ---- 5. urgent → Step Functions escalation with a real retry ----
submit '{"category":"parks","priority":"urgent","description":"verify: tree down across Ridgeline Trail","simulate":"none"}'
check $? "urgent request accepted"
wait_hop "$REQ_ID" sfn-resolved 25 2; check $? "escalation workflow ran to resolution"
ATTEMPTS=$(echo "$TRACE" | jq '[.hops[] | select(.hop == "sfn-dispatch-attempt")] | length')
[ "$ATTEMPTS" -ge 2 ]; check $? "dispatch retried after the simulated transient fault ($ATTEMPTS attempts)"
echo "$TRACE" | jq -e '.hops[] | select(.hop == "sfn-dispatched")' > /dev/null
check $? "retry policy absorbed the fault (crew dispatched)"
echo "$TRACE" | jq -e '.meta.escalation == "resolved"' > /dev/null
check $? "request record marked escalation=resolved"

# ---- 6. poison message → DLQ → bad-order card → operator redrive → recovered ----
submit '{"category":"roads","priority":"normal","description":"verify: poison message for the DLQ drill","simulate":"fail"}'
check $? "poison request accepted"
POISON_ID=$REQ_ID
# 3 receives with a 30s visibility timeout: allow ~3 minutes.
wait_hop "$REQ_ID" dead-lettered 40 5; check $? "poison message exhausted 3 attempts and dead-lettered"
ATTEMPTS=$(echo "$TRACE" | jq '[.hops[] | select(.hop == "attempt-failed")] | length')
[ "$ATTEMPTS" -ge 2 ]; check $? "trace recorded the failed delivery attempts ($((ATTEMPTS+1)) total)"
# The physical move happens on the delivery cycle AFTER the final failed
# attempt (~30s visibility timeout), so poll for the depth before redriving.
DEPTH=0
for i in $(seq 1 15); do
  DEPTH=$(curl -sS "$SITE/api/stats" | jq '.dlq.depths.roads')
  [ "$DEPTH" -ge 1 ] && break
  sleep 5
done
[ "$DEPTH" -ge 1 ]; check $? "roads DLQ depth is visible via stats ($DEPTH message)"

# The bad-order card: peek the DLQ (ReceiveMessage, not consumed) before redriving.
CARDS=$(curl -sS "$SITE/api/dlq/roads")
echo "$CARDS" | jq -e --arg id "$POISON_ID" '.cards[] | select(.requestId == $id)' > /dev/null
check $? "bad-order card readable for the dead-lettered message"
echo "$CARDS" | jq -e --arg id "$POISON_ID" '.cards[] | select(.requestId == $id) | .receiveCount >= 3 and .sourceQueue == "evt-dispatch-roads" and (.sentAt | length > 0)' > /dev/null
check $? "card carries receive count, original enqueue time, and source queue"
# A peeked message is invisible for ~1s; give it a beat before the move task.
sleep 2

CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/api/redrive" \
  -H 'content-type: application/json' -d '{"queue":"roads"}')
[ "$CODE" = "202" ]; check $? "operator redrive started (202, after the peek)"
# A move task snapshots the visible queue when it starts; if SQS's approximate
# counts haven't settled it can complete having moved nothing, so re-fire once
# before calling the drill failed (the dashboard's button behaves the same way).
if ! wait_hop "$REQ_ID" recovered 15 4; then
  curl -sS -o /dev/null -X POST "$SITE/api/redrive" \
    -H 'content-type: application/json' -d '{"queue":"roads"}'
  wait_hop "$REQ_ID" recovered 20 4
fi
check $? "redriven message processed cleanly (recovered)"
echo "$TRACE" | jq -e '.meta.status == "recovered"' > /dev/null
check $? "request record marked status=recovered"

# ---- 7. the interlocking tester (TestEventPattern under glass) ----
PT=$(curl -sS -X POST "$SITE/api/pattern-test" -H 'content-type: application/json' -d '{
  "event": {"source":"alpenglow.dispatch","detail-type":"service.request.submitted",
            "detail":{"category":"roads","priority":"urgent","description":"verify: tester"}},
  "pattern": {"source":["alpenglow.dispatch"],"detail":{"category":["roads","utilities"]}}}')
echo "$PT" | jq -e '.matched == true' > /dev/null; check $? "pattern tester: visitor pattern matches (Result true)"
echo "$PT" | jq -e '.rules | length == 5' > /dev/null; check $? "pattern tester: event checked against all five live rules"
echo "$PT" | jq -e '.rules[] | select(.name == "route-roads") | .matched' > /dev/null
check $? "pattern tester: urgent roads event lights route-roads"
echo "$PT" | jq -e '.rules[] | select(.name == "route-parks") | .matched | not' > /dev/null
check $? "pattern tester: ... and does not light route-parks"
BADPT=$(curl -sS -X POST "$SITE/api/pattern-test" -H 'content-type: application/json' \
  -d '{"event":{"detail":{}},"pattern":{"source":"not-a-list"}}')
echo "$BADPT" | jq -e '.message | contains("must be an object or an array")' > /dev/null
check $? "pattern tester: malformed pattern surfaces EventBridge's own reason (400)"

# ---- 8. the block order: standard vs FIFO race + dedup ----
RACE_ID=$(curl -sS -X POST "$SITE/api/race" | jq -r '.raceId')
[ -n "$RACE_ID" ] && [ "$RACE_ID" != "null" ]; check $? "race accepted (id $RACE_ID)"
for i in $(seq 1 20); do
  RACE=$(curl -sS "$SITE/api/race/$RACE_ID")
  echo "$RACE" | jq -e '.meta.stdArrived >= 10 and .meta.fifoArrived >= 10' > /dev/null && break
  sleep 3
done
echo "$RACE" | jq -e '.meta.stdArrived >= 10 and .meta.fifoArrived >= 10' > /dev/null
check $? "all 10 cars arrived on both tracks"
echo "$RACE" | jq -e '[.arrivals.fifo[].seq] == [1,2,3,4,5,6,7,8,9,10]' > /dev/null
check $? "FIFO track delivered in strict block order (1-10)"
echo "$RACE" | jq -e '[.arrivals.standard[].seq] | length == 10 and (sort == [1,2,3,4,5,6,7,8,9,10])' > /dev/null
check $? "standard track delivered every car exactly once (any order)"
echo "$RACE" | jq -e '.meta.dupAbsorbed == true' > /dev/null
check $? "duplicate send of car 7 absorbed (SQS answered with the original MessageId)"

# ---- 9. the second section: archive replay ----
RS=$(curl -sS "$SITE/api/replay")
echo "$RS" | jq -e '.archive.state == "ENABLED"' > /dev/null; check $? "event archive is enabled"
# Ingestion into a bus archive lags PutEvents by a few seconds; this run's own
# submissions from sections 3-6 must be in the vault before we replay them.
for i in $(seq 1 24); do
  N=$(curl -sS "$SITE/api/replay" | jq '.archive.events')
  [ "$N" -ge 1 ] && break
  sleep 5
done
[ "$N" -ge 1 ]; check $? "archive has ingested events ($N in the vault)"
RSTART=$(curl -sS -X POST "$SITE/api/replay" -H 'content-type: application/json' -d '{"window":"1h"}')
RNAME=$(echo "$RSTART" | jq -r '.replayName')
[ -n "$RNAME" ] && [ "$RNAME" != "null" ]; check $? "replay started (202, $RNAME)"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/api/replay" \
  -H 'content-type: application/json' -d '{"window":"1h"}')
[ "$CODE" = "409" ]; check $? "second concurrent replay refused (409, one at a time)"
for i in $(seq 1 40); do
  RS=$(curl -sS "$SITE/api/replay")
  echo "$RS" | jq -e --arg n "$RNAME" '.last.replayName == $n and .last.state == "COMPLETED"' > /dev/null && break
  sleep 10
done
echo "$RS" | jq -e --arg n "$RNAME" '.last.replayName == $n and .last.state == "COMPLETED"' > /dev/null
check $? "replay ran to COMPLETED and released the one-at-a-time lock"
# The window covered this run's own events, so second sections must appear.
POISON_SHORT="REQ-$(echo "$POISON_ID" | tr -d '-' | cut -c1-4 | tr 'a-z' 'A-Z')"
for i in $(seq 1 12); do
  FEED=$(curl -sS "$SITE/api/requests")
  echo "$FEED" | jq -e '.requests[] | select(.origin == "replay")' > /dev/null && break
  sleep 5
done
echo "$FEED" | jq -e '.requests[] | select(.origin == "replay") | .replayOf | length > 0' > /dev/null
check $? "second sections on the arrivals board, flagged with the run they repeat"
# The replayed poison message dead-letters AGAIN on its own second-section
# trace (the archive replays failures as honestly as successes) . . .
RP_ID=$(echo "$FEED" | jq -r --arg of "$POISON_SHORT" \
  '[.requests[] | select(.origin == "replay" and .replayOf == $of)][0].requestId')
[ -n "$RP_ID" ] && [ "$RP_ID" != "null" ]; check $? "the poison message re-ran as its own second section"
wait_hop "$RP_ID" dead-lettered 40 5; check $? "replayed poison dead-lettered again on the second-section trace"
# ... and the yard gets swept before verify signs off. The replay window can
# resurrect poison from earlier same-day runs on any department's clock, so
# keep redriving whatever shows up until every DLQ reads empty.
sleep 35 # the physical DLQ move lands one delivery cycle after the final failure
for i in $(seq 1 24); do
  STATS=$(curl -sS "$SITE/api/stats")
  TOTAL=$(echo "$STATS" | jq '.dlq.total')
  [ "$TOTAL" = "0" ] && break
  for dept in roads utilities parks; do
    D=$(echo "$STATS" | jq ".dlq.depths.$dept")
    [ "$D" -ge 1 ] && curl -sS -o /dev/null -X POST "$SITE/api/redrive" \
      -H 'content-type: application/json' -d "{\"queue\":\"$dept\"}"
  done
  sleep 8
done
[ "$TOTAL" = "0" ]; check $? "rip track swept clean after the drill (all DLQs empty)"

# ---- 10. supporting cast ----
STATE=$(aws scheduler get-schedule --name "$($TF output -raw heartbeat_schedule)" --query State --output text)
[ "$STATE" = "ENABLED" ]; check $? "heartbeat schedule is enabled (dashboard stays alive)"
FEED=$(curl -sS "$SITE/api/requests")
echo "$FEED" | jq -e '.requests | length >= 4' > /dev/null; check $? "activity feed lists recent requests"
TOTALS=$(curl -sS "$SITE/api/stats")
echo "$TOTALS" | jq -e '.totals.events >= 4 and .totals.notifications >= 1 and .totals.retries >= 1 and .totals.deadLetters >= 1' > /dev/null
check $? "lifetime counters advanced (events, notifications, retries, dead letters)"
echo "$TOTALS" | jq -e '.totals.patternTests >= 1 and .totals.races >= 1 and .totals.replays >= 1 and .totals.replayedEvents >= 1' > /dev/null
check $? "exhibit counters advanced (pattern tests, races, replays, replayed events)"
echo "$TOTALS" | jq -e '.usage.used >= 4 and .usage.limit == 1000' > /dev/null
check $? "global daily cap counter is counting toward its limit"
echo "$TOTALS" | jq -e '.usage.pattern.limit == 500 and .usage.race.limit == 100 and .usage.replay.limit == 10 and .usage.replay.used >= 1' > /dev/null
check $? "per-exhibit daily caps are live (pattern 500, race 100, replay 10)"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" = "0" ]
