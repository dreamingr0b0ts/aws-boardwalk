#!/usr/bin/env bash
# End-to-end verification against the LIVE deployment. The plank isn't done
# until every check here passes — including the failure path: the JOB=fail
# container must actually exit 1 and surface its stopped state, and the
# concurrency gate must actually turn a second launch away.
set -uo pipefail
cd "$(dirname "$0")/.."

TF="terraform -chdir=infra"
SITE=$($TF output -raw site_url)

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
check(){ if [ "$1" = "0" ]; then ok "$2"; else bad "$2"; fi }

# Launch a job and wait for STOPPED (Fargate provision+pull+run+stop ≈ 1-2 min).
# Sets RUN_ID, RUN_JSON (final GET body), SAW_RUNNING.
launch_and_wait() { # usage: launch_and_wait <job>
  local body; body=$(curl -sS -X POST "$SITE/api/runs" -H 'content-type: application/json' -d "{\"job\":\"$1\"}")
  RUN_ID=$(echo "$body" | jq -r '.runId // empty')
  [ -n "$RUN_ID" ] || { echo "    launch refused: $body"; return 1; }
  SAW_RUNNING=0
  for i in $(seq 1 100); do
    RUN_JSON=$(curl -sS "$SITE/api/runs/$RUN_ID")
    local status; status=$(echo "$RUN_JSON" | jq -r '.run.lastStatus // empty')
    [ "$status" = "RUNNING" ] && SAW_RUNNING=1
    [ "$status" = "STOPPED" ] && return 0
    sleep 3
  done
  return 1
}

echo "verifying $SITE"

# ---- 1. static site + security headers ----
HDRS=$(curl -sS -D - -o /tmp/ctr-index.html "$SITE/" | tr -d '\r')
grep -q "Alpenglow Batch Works" /tmp/ctr-index.html; check $? "site serves the Batch Works page"
echo "$HDRS" | grep -qi "strict-transport-security"; check $? "HSTS header present"
echo "$HDRS" | grep -qi "content-security-policy"; check $? "CSP header present"

# ---- 2. image pipeline is real: CodeBuild built it, ECR scanned it ----
STATUS=$(curl -sS "$SITE/api/status")
echo "$STATUS" | jq -e '.image.digest | startswith("sha256:")' > /dev/null
check $? "ECR holds a ctr-app:latest image (digest reported)"
echo "$STATUS" | jq -e '.lastBuild.status == "SUCCEEDED"' > /dev/null
check $? "last CodeBuild image build SUCCEEDED"
echo "$STATUS" | jq -e '.scan.status == "COMPLETE" or .scan.status == "ACTIVE"' > /dev/null
check $? "scan-on-push ran (status $(echo "$STATUS" | jq -r '.scan.status'))"
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

# ---- 4. the headline act: launch a container, watch it, read its report ----
BODY=$(curl -sS -X POST "$SITE/api/runs" -H 'content-type: application/json' -d '{"job":"report"}')
RUN_ID=$(echo "$BODY" | jq -r '.runId // empty')
[ -n "$RUN_ID" ] && [[ "$RUN_ID" =~ ^[a-f0-9]{32}$ ]]; check $? "report job launched (task $RUN_ID)"

# concurrency gate: a second launch while the first is in flight must 409
CONC=$(curl -sS -o /tmp/ctr-conc.json -w '%{http_code}' -X POST "$SITE/api/runs" \
  -H 'content-type: application/json' -d '{"job":"report"}')
[ "$CONC" = "409" ] && [ "$(jq -r '.runId' /tmp/ctr-conc.json)" = "$RUN_ID" ]
check $? "second launch while in flight → 409 pointing at the live run"

SAW_RUNNING=0
for i in $(seq 1 100); do
  RUN_JSON=$(curl -sS "$SITE/api/runs/$RUN_ID")
  ST=$(echo "$RUN_JSON" | jq -r '.run.lastStatus // empty')
  [ "$ST" = "RUNNING" ] && SAW_RUNNING=1
  [ "$ST" = "STOPPED" ] && break
  sleep 3
done
[ "$ST" = "STOPPED" ]; check $? "task reached STOPPED (provision → pull → run → stop)"
[ "$SAW_RUNNING" = "1" ]; check $? "task was observed RUNNING along the way"
echo "$RUN_JSON" | jq -e '.run.exitCode == 0' > /dev/null; check $? "container exited 0"
echo "$RUN_JSON" | jq -e '.run.durationMs > 0' > /dev/null; check $? "duration recorded ($(echo "$RUN_JSON" | jq -r '.run.durationMs')ms)"

LOGS=$(curl -sS "$SITE/api/runs/$RUN_ID" | jq -r '.logs[].m')
echo "$LOGS" | grep -q '\[boot\].*task limits: 0.25 vCPU / 512 MiB'; check $? "logs prove the 0.25 vCPU / 512 MiB task size from inside the container"
echo "$LOGS" | grep -q '\[4/5\] upload complete'; check $? "logs show the S3 artifact upload (task role)"
echo "$LOGS" | grep -q '\[5/5\] done'; check $? "logs show a clean finish"

ART=$(curl -sS "$SITE/api/runs/$RUN_ID" | jq -r '.artifact // empty')
[ "$ART" = "/artifacts/$RUN_ID.html" ]; check $? "API links the report artifact"
ART_HTML=$(curl -sS "$SITE$ART")
echo "$ART_HTML" | grep -q "Daily Operations Report"; check $? "report artifact is served through CloudFront"
echo "$ART_HTML" | grep -q "$RUN_ID"; check $? "report was written by THIS task (task id in the footer)"

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
echo "$LOGS" | grep -q 'ledger checksum mismatch'; check $? "failure reason visible in the logs"

# ---- 7. the scheduled half of run-task ----
SCHED=$(aws scheduler get-schedule --name "$($TF output -raw daily_schedule)" --query 'State' --output text 2>/dev/null)
[ "$SCHED" = "ENABLED" ]; check $? "daily scheduled run is ENABLED (EventBridge Scheduler)"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" = "0" ]
