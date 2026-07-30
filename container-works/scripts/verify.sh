#!/usr/bin/env bash
# End-to-end verification against the LIVE deployment. The plank isn't done
# until every check here passes — including every failure exhibit: the fail
# job must exit 1, the oom job must be killed by the task memory limit, the
# drain job must survive SIGTERM cleanly, the stubborn job must be SIGKILLed,
# both bake-off races must produce an honest winner, and the concurrency gate
# must turn a second launch away. Budget: ~9 of the day's launch slots.
set -uo pipefail
cd "$(dirname "$0")/.."

TF="terraform -chdir=infra"
SITE=$($TF output -raw site_url)

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
check(){ if [ "$1" = "0" ]; then ok "$2"; else bad "$2"; fi }

# Poll a run id until STOPPED (Fargate provision+pull+run+stop ≈ 1-2 min;
# stubborn adds a 30s stopTimeout standoff). Sets RUN_JSON, SAW_RUNNING.
# The shared WAF rate rule (300 req/5min/IP) can answer a long-polling suite
# with an HTML 403 for a stretch — parse quietly and back off instead of
# spamming jq errors (seen live 2026-07-30).
wait_stopped() { # usage: wait_stopped <runId> [max_polls]
  local id=$1 max=${2:-120} st=""
  SAW_RUNNING=0
  for i in $(seq 1 "$max"); do
    RUN_JSON=$(curl -sS "$SITE/api/runs/$id")
    case "$RUN_JSON" in
      '<'*) sleep 10; continue ;; # WAF/CloudFront HTML error page: back off
    esac
    st=$(echo "$RUN_JSON" | jq -r '.run.lastStatus // empty' 2>/dev/null)
    [ "$st" = "RUNNING" ] && SAW_RUNNING=1
    [ "$st" = "STOPPED" ] && return 0
    sleep 3
  done
  return 1
}

# Launch a single job and wait for STOPPED. Sets RUN_ID, RUN_JSON, SAW_RUNNING.
launch_and_wait() { # usage: launch_and_wait <job>
  local body; body=$(curl -sS -X POST "$SITE/api/runs" -H 'content-type: application/json' -d "{\"job\":\"$1\"}")
  RUN_ID=$(echo "$body" | jq -r '.runId // empty')
  [ -n "$RUN_ID" ] || { echo "    launch refused: $body"; return 1; }
  wait_stopped "$RUN_ID"
}

# Poll until a run reports RUNNING (for the stop-button exhibits). Sets RUN_ID.
launch_and_wait_running() { # usage: launch_and_wait_running <job>
  local body st; body=$(curl -sS -X POST "$SITE/api/runs" -H 'content-type: application/json' -d "{\"job\":\"$1\"}")
  RUN_ID=$(echo "$body" | jq -r '.runId // empty')
  [ -n "$RUN_ID" ] || { echo "    launch refused: $body"; return 1; }
  for i in $(seq 1 60); do
    st=$(curl -sS "$SITE/api/runs/$RUN_ID" | jq -r '.run.lastStatus // empty' 2>/dev/null)
    [ "$st" = "RUNNING" ] && return 0
    [ "$st" = "STOPPED" ] && return 1
    sleep 3
  done
  return 1
}

echo "verifying $SITE"

# ---- 1. static site + security headers ----
HDRS=$(curl -sS -D - -o /tmp/ctr-index.html "$SITE/" | tr -d '\r')
grep -q "Alpenglow Batch Works" /tmp/ctr-index.html; check $? "site serves the Batch Works page"
echo "$HDRS" | grep -qi "strict-transport-security" || [ $? -eq 141 ]; check $? "HSTS header present"
echo "$HDRS" | grep -qi "content-security-policy" || [ $? -eq 141 ]; check $? "CSP header present"

# ---- 2. image pipeline is real: CodeBuild built it, ECR scanned it, twice ----
STATUS=$(curl -sS "$SITE/api/status")
echo "$STATUS" | jq -e '.image.digest | startswith("sha256:")' > /dev/null
check $? "ECR holds a ctr-app:latest image (digest reported)"
echo "$STATUS" | jq -e '.imageFat.digest | startswith("sha256:")' > /dev/null
check $? "ECR holds the ctr-app:fat exhibit image"
echo "$STATUS" | jq -e '.imageFat.sizeBytes > (.image.sizeBytes * 3)' > /dev/null
check $? "fat image is at least 3x the slim image ($(echo "$STATUS" | jq -r '.image.sizeBytes') vs $(echo "$STATUS" | jq -r '.imageFat.sizeBytes') bytes)"
echo "$STATUS" | jq -e '.lastBuild.status == "SUCCEEDED"' > /dev/null
check $? "last CodeBuild image build SUCCEEDED"
echo "$STATUS" | jq -e '.scan.status == "COMPLETE" or .scan.status == "ACTIVE"' > /dev/null
check $? "scan-on-push ran for slim (status $(echo "$STATUS" | jq -r '.scan.status'))"
echo "$STATUS" | jq -e '.scanFat.status == "COMPLETE" or .scanFat.status == "ACTIVE"' > /dev/null
check $? "scan-on-push ran for fat (status $(echo "$STATUS" | jq -r '.scanFat.status'))"
echo "$STATUS" | jq -e '.prices.vcpuHour > 0 and .prices.gbHour > 0' > /dev/null
check $? "receipt rates advertised for the live meter"
USED_BEFORE=$(echo "$STATUS" | jq -r '.usage.used')
echo "$STATUS" | jq -e '.usage.limit > 0' > /dev/null; check $? "daily launch cap advertised ($(echo "$STATUS" | jq -r '.usage.limit')/day)"

# ---- 3. input validation ----
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/api/runs" \
  -H 'content-type: application/json' -d '{"job":"cryptominer"}')
[ "$CODE" = "400" ]; check $? "unknown job type rejected (400)"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "$SITE/api/runs/not-a-task-id")
[ "$CODE" = "400" ]; check $? "malformed run id rejected (400)"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "$SITE/api/runs/00000000000000000000000000000000")
[ "$CODE" = "404" ]; check $? "unknown run id → 404"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/api/runs/not-a-task-id/stop")
[ "$CODE" = "400" ]; check $? "malformed stop id rejected (400)"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/api/runs/00000000000000000000000000000000/stop")
[ "$CODE" = "404" ]; check $? "stop on unknown task → 404"

# ---- 4. the headline act: launch a container, watch it, read its report ----
BODY=$(curl -sS -X POST "$SITE/api/runs" -H 'content-type: application/json' -d '{"job":"report"}')
RUN_ID=$(echo "$BODY" | jq -r '.runId // empty')
[ -n "$RUN_ID" ] && [[ "$RUN_ID" =~ ^[a-f0-9]{32}$ ]]; check $? "report job launched (task $RUN_ID)"

# concurrency gate: a second launch while the first is in flight must 409
CONC=$(curl -sS -o /tmp/ctr-conc.json -w '%{http_code}' -X POST "$SITE/api/runs" \
  -H 'content-type: application/json' -d '{"job":"report"}')
[ "$CONC" = "409" ] && [ "$(jq -r '.runId' /tmp/ctr-conc.json)" = "$RUN_ID" ]
check $? "second launch while in flight → 409 pointing at the live run"

wait_stopped "$RUN_ID"; ST=$(echo "$RUN_JSON" | jq -r '.run.lastStatus')
[ "$ST" = "STOPPED" ]; check $? "task reached STOPPED (provision → pull → run → stop)"
[ "$SAW_RUNNING" = "1" ]; check $? "task was observed RUNNING along the way"
echo "$RUN_JSON" | jq -e '.run.exitCode == 0' > /dev/null; check $? "container exited 0"
echo "$RUN_JSON" | jq -e '.run.durationMs > 0' > /dev/null; check $? "duration recorded ($(echo "$RUN_JSON" | jq -r '.run.durationMs')ms)"

# the cold-start anatomy + the bake ticket
echo "$RUN_JSON" | jq -e '.run.pullStartedAt and .run.pullStoppedAt and .run.startedAt' > /dev/null
check $? "anatomy timestamps present (pull start/stop, container start)"
echo "$RUN_JSON" | jq -e '.run.pullMs > 0 and .run.billedMs > .run.pullMs' > /dev/null
check $? "pull time and billing window derived (pull $(echo "$RUN_JSON" | jq -r '.run.pullMs')ms)"
echo "$RUN_JSON" | jq -e '.run.cost.totalUsd > 0 and .run.cost.totalUsd < 0.01' > /dev/null
check $? "bake ticket priced the run ($(echo "$RUN_JSON" | jq -r '.run.cost.totalUsd') USD)"

LOGS=$(curl -sS "$SITE/api/runs/$RUN_ID" | jq -r '.logs[].m')
echo "$LOGS" | grep -q '\[boot\].*task limits: 0.25 vCPU / 512 MiB' || [ $? -eq 141 ]; check $? "logs prove the 0.25 vCPU / 512 MiB task size from inside the container"
echo "$LOGS" | grep -q '\[4/5\] upload complete' || [ $? -eq 141 ]; check $? "logs show the S3 artifact upload (task role)"
echo "$LOGS" | grep -q '\[5/5\] done' || [ $? -eq 141 ]; check $? "logs show a clean finish"

ART=$(curl -sS "$SITE/api/runs/$RUN_ID" | jq -r '.artifact // empty')
[ "$ART" = "/artifacts/$RUN_ID.html" ]; check $? "API links the report artifact"
ART_HTML=$(curl -sS "$SITE$ART")
echo "$ART_HTML" | grep -q "Daily Operations Report" || [ $? -eq 141 ]; check $? "report artifact is served through CloudFront"
echo "$ART_HTML" | grep -q "$RUN_ID" || [ $? -eq 141 ]; check $? "report was written by THIS task (task id in the footer)"

# ---- 5. run bookkeeping ----
RUNS=$(curl -sS "$SITE/api/runs")
echo "$RUNS" | jq -e --arg id "$RUN_ID" '.runs[] | select(.runId == $id) | select(.source == "visitor") | select(.exitCode == 0)' > /dev/null
check $? "recent-runs feed shows the run (source=visitor, exit 0)"
USED_AFTER=$(curl -sS "$SITE/api/status" | jq -r '.usage.used')
[ "$USED_AFTER" -gt "$USED_BEFORE" ]; check $? "daily launch counter incremented ($USED_BEFORE → $USED_AFTER)"

# ---- 6. the failure path is honest ----
launch_and_wait fail; check $? "failing job launched and reached STOPPED"
echo "$RUN_JSON" | jq -e '.run.exitCode == 1' > /dev/null; check $? "failing container exited 1"
echo "$RUN_JSON" | jq -e '.artifact == null' > /dev/null; check $? "no artifact link for a failed run"
LOGS=$(echo "$RUN_JSON" | jq -r '.logs[].m')
echo "$LOGS" | grep -q 'ledger checksum mismatch' || [ $? -eq 141 ]; check $? "failure reason visible in the logs"

# ---- 7. the bake-off: two ovens, one workload ----
RACE=$(curl -sS -X POST "$SITE/api/runs" -H 'content-type: application/json' -d '{"job":"race-size"}')
RACE_ID=$(echo "$RACE" | jq -r '.raceId // empty')
LANE_STD=$(echo "$RACE" | jq -r '.lanes[] | select(.variant == "standard") | .runId')
LANE_BOOST=$(echo "$RACE" | jq -r '.lanes[] | select(.variant == "boost") | .runId')
[ -n "$RACE_ID" ] && [ -n "$LANE_STD" ] && [ -n "$LANE_BOOST" ]
check $? "size race launched two lanes (race $RACE_ID)"

CONC=$(curl -sS -o /tmp/ctr-race-conc.json -w '%{http_code}' -X POST "$SITE/api/runs" \
  -H 'content-type: application/json' -d '{"job":"report"}')
[ "$CONC" = "409" ] && [ "$(jq -r '.raceId' /tmp/ctr-race-conc.json)" = "$RACE_ID" ] \
  && [ "$(jq -r '.lanes | length' /tmp/ctr-race-conc.json)" = "2" ]
check $? "launch during a race → 409 handing over both lanes"

wait_stopped "$LANE_STD" 140; check $? "standard lane reached STOPPED"
STD_JSON=$RUN_JSON
wait_stopped "$LANE_BOOST" 140; check $? "boost lane reached STOPPED"
BOOST_JSON=$RUN_JSON
echo "$STD_JSON"   | jq -e '.run.exitCode == 0' > /dev/null; check $? "standard lane exited 0"
echo "$BOOST_JSON" | jq -e '.run.exitCode == 0' > /dev/null; check $? "boost lane exited 0"
STD_APP=$(echo "$STD_JSON" | jq -r '.run.appMs // 0'); BOOST_APP=$(echo "$BOOST_JSON" | jq -r '.run.appMs // 0')
[ "$BOOST_APP" -gt 0 ] && [ "$STD_APP" -gt "$BOOST_APP" ]
check $? "1 vCPU lane crunched the same workload faster (${BOOST_APP}ms vs ${STD_APP}ms)"
echo "$STD_JSON" | jq -e '.run.cpu == 256' > /dev/null && echo "$BOOST_JSON" | jq -e '.run.cpu == 1024' > /dev/null
check $? "lanes really ran at 0.25 and 1 vCPU (task-level sizing)"

RACE=$(curl -sS -X POST "$SITE/api/runs" -H 'content-type: application/json' -d '{"job":"race-image"}')
LANE_SLIM=$(echo "$RACE" | jq -r '.lanes[] | select(.variant == "standard") | .runId')
LANE_FAT=$(echo "$RACE" | jq -r '.lanes[] | select(.variant == "fat") | .runId')
[ -n "$LANE_SLIM" ] && [ -n "$LANE_FAT" ]; check $? "image race launched two lanes"
wait_stopped "$LANE_SLIM" 140; check $? "slim lane reached STOPPED"
SLIM_JSON=$RUN_JSON
wait_stopped "$LANE_FAT" 140; check $? "fat lane reached STOPPED"
FAT_JSON=$RUN_JSON
SLIM_PULL=$(echo "$SLIM_JSON" | jq -r '.run.pullMs // 0'); FAT_PULL=$(echo "$FAT_JSON" | jq -r '.run.pullMs // 0')
[ "$SLIM_PULL" -gt 0 ] && [ "$FAT_PULL" -gt "$SLIM_PULL" ]
check $? "heavy image lost the pull race (${SLIM_PULL}ms vs ${FAT_PULL}ms)"

# ---- 8. the failure museum: OOM ----
launch_and_wait oom; check $? "oom job launched and reached STOPPED"
echo "$RUN_JSON" | jq -e '.run.exitCode == 137' > /dev/null; check $? "oom container was SIGKILLed (exit 137)"
echo "$RUN_JSON" | jq -r '.run.containerReason // .run.stoppedReason' | grep -qi 'outofmemory' || [ $? -eq 141 ]
check $? "ECS recorded the OutOfMemoryError reason"
LOGS=$(echo "$RUN_JSON" | jq -r '.logs[].m')
echo "$LOGS" | grep -q '\[oom\] holding' || [ $? -eq 141 ]; check $? "oom logs show the allocations marching toward the limit"

# ---- 9. the failure museum: SIGTERM, both endings ----
launch_and_wait_running drain; check $? "drain job launched and reached RUNNING"
DRAIN_ID=$RUN_ID
sleep 6 # let a proof line land
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/api/runs/$DRAIN_ID/stop")
[ "$CODE" = "202" ]; check $? "stop endpoint accepted the pull-early request (202)"
wait_stopped "$DRAIN_ID"; check $? "drained task reached STOPPED"
echo "$RUN_JSON" | jq -e '.run.exitCode == 0' > /dev/null; check $? "drain job exited 0 inside the grace window"
LOGS=$(echo "$RUN_JSON" | jq -r '.logs[].m')
echo "$LOGS" | grep -q '\[sigterm\] clean shutdown' || [ $? -eq 141 ]; check $? "drain logs show the SIGTERM trap firing"
echo "$RUN_JSON" | jq -r '.run.stoppedReason' | grep -q 'Pulled early by a visitor' || [ $? -eq 141 ]
check $? "StopTask reason recorded on the task"

launch_and_wait_running stubborn; check $? "stubborn job launched and reached RUNNING"
STUB_ID=$RUN_ID
sleep 6
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/api/runs/$STUB_ID/stop")
[ "$CODE" = "202" ]; check $? "stop endpoint accepted the stubborn pull (202)"
wait_stopped "$STUB_ID"; check $? "stubborn task reached STOPPED (after the 30s standoff)"
echo "$RUN_JSON" | jq -e '.run.exitCode == 137' > /dev/null; check $? "stubborn job was SIGKILLed at stopTimeout (exit 137)"
LOGS=$(echo "$RUN_JSON" | jq -r '.logs[].m')
echo "$LOGS" | grep -q 'IGNORING' || [ $? -eq 141 ]; check $? "stubborn logs show it ignoring SIGTERM"

# ---- 10. the scheduled half of run-task ----
SCHED=$(aws scheduler get-schedule --name "$($TF output -raw daily_schedule)" --query 'State' --output text 2>/dev/null)
[ "$SCHED" = "ENABLED" ]; check $? "daily scheduled run is ENABLED (EventBridge Scheduler)"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" = "0" ]
