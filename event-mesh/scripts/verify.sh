#!/usr/bin/env bash
# End-to-end verification against the LIVE deployment. The plank isn't done
# until every check here passes — including the failure paths: a poison
# message must actually land in a DLQ and come back out via operator redrive,
# and the urgent workflow must show a real retry in its trace.
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
echo "$HDRS" | grep -qi "strict-transport-security"; check $? "HSTS header present"
echo "$HDRS" | grep -qi "content-security-policy"; check $? "CSP header present"

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

# ---- 6. poison message → DLQ → operator redrive → recovered ----
submit '{"category":"roads","priority":"normal","description":"verify: poison message for the DLQ drill","simulate":"fail"}'
check $? "poison request accepted"
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

CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/api/redrive" \
  -H 'content-type: application/json' -d '{"queue":"roads"}')
[ "$CODE" = "202" ]; check $? "operator redrive started (202)"
wait_hop "$REQ_ID" recovered 30 4; check $? "redriven message processed cleanly (recovered)"
echo "$TRACE" | jq -e '.meta.status == "recovered"' > /dev/null
check $? "request record marked status=recovered"

# ---- 7. supporting cast ----
STATE=$(aws scheduler get-schedule --name "$($TF output -raw heartbeat_schedule)" --query State --output text)
[ "$STATE" = "ENABLED" ]; check $? "heartbeat schedule is enabled (dashboard stays alive)"
FEED=$(curl -sS "$SITE/api/requests")
echo "$FEED" | jq -e '.requests | length >= 4' > /dev/null; check $? "activity feed lists recent requests"
TOTALS=$(curl -sS "$SITE/api/stats")
echo "$TOTALS" | jq -e '.totals.events >= 4 and .totals.notifications >= 1 and .totals.retries >= 1 and .totals.deadLetters >= 1' > /dev/null
check $? "lifetime counters advanced (events, notifications, retries, dead letters)"
echo "$TOTALS" | jq -e '.usage.used >= 4 and .usage.limit == 1000' > /dev/null
check $? "global daily cap counter is counting toward its limit"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" = "0" ]
