#!/usr/bin/env bash
# End-to-end verification for the deploy-demo-teardown plank. Runs in two
# modes, decided by whether the demo root has state:
#   DEPLOYED  → verify every exhibit live (trail, KMS, GuardDuty, Security
#               Hub, Config/NIST pack, boundary simulation) + fresh evidence
#   TORN DOWN → verify the always-on half AND prove the idle state: no
#               detector, no hub, no recorder, no trail left billing
set -uo pipefail
cd "$(dirname "$0")/.."

TF="terraform -chdir=infra"
TFD="terraform -chdir=demo"
SITE=$($TF output -raw site_url)

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
check(){ if [ "$1" = "0" ]; then ok "$2"; else bad "$2"; fi }

echo "verifying $SITE"

# ---- 1. always-on: static site + security headers ----
HDRS=$(curl -sS -D - -o /tmp/sec-index.html "$SITE/" | tr -d '\r')
grep -q "Alpenglow Security Posture" /tmp/sec-index.html; check $? "site serves the Security Posture page"
echo "$HDRS" | grep -qi "strict-transport-security" || [ $? -eq 141 ]; check $? "HSTS header present"
echo "$HDRS" | grep -qi "content-security-policy" || [ $? -eq 141 ]; check $? "CSP header present"

# ---- 2. always-on: persisted evidence artifacts ----
STATUS=$(curl -sS "$SITE/evidence/status.json")
echo "$STATUS" | jq -e 'has("deployed")' > /dev/null; check $? "status.json served (deployed=$(echo "$STATUS" | jq -r '.deployed'))"
EV=$(curl -sS "$SITE/evidence/evidence.json")
echo "$EV" | jq -e '.generatedAt and .cloudtrail and .guardduty and .securityHub and .config and .boundary' > /dev/null
check $? "evidence.json has every exhibit section"
curl -sS "$SITE/evidence/evidence.html" | grep -q "Security Posture Evidence Report" || [ $? -eq 141 ]
check $? "standalone evidence.html served through CloudFront"

# evidence agrees the audit trail was healthy when generated
echo "$EV" | jq -e '.cloudtrail.logging and .cloudtrail.multiRegion and .cloudtrail.logFileValidation and .cloudtrail.kmsEncrypted' > /dev/null
check $? "evidence: trail was logging, multi-region, validated, KMS-encrypted"
echo "$EV" | jq -e '.kms.rotationEnabled and .kms.customerManaged' > /dev/null
check $? "evidence: customer-managed KMS key with rotation"
echo "$EV" | jq -e '.guardduty.total > 0' > /dev/null
check $? "evidence: GuardDuty findings captured ($(echo "$EV" | jq -r '.guardduty.total'))"
echo "$EV" | jq -e '(.config.rules.COMPLIANT + .config.rules.NON_COMPLIANT) > 0' > /dev/null
check $? "evidence: NIST pack rules evaluated ($(echo "$EV" | jq -r '.config.rules.COMPLIANT') compliant / $(echo "$EV" | jq -r '.config.rules.NON_COMPLIANT') non-compliant)"

# the boundary exhibit: proof rows must show the intersection behavior
B_GET=$(echo "$EV" | jq -r '.boundary.simulations[] | select(.action=="s3:GetObject") | .decision')
B_PUT=$(echo "$EV" | jq -r '.boundary.simulations[] | select(.action=="s3:PutObject") | .decision')
B_IAM=$(echo "$EV" | jq -r '.boundary.simulations[] | select(.action=="iam:CreateUser") | .decision')
[ "$B_GET" = "allowed" ]; check $? "boundary sim: s3:GetObject allowed (inside policy ∩ boundary)"
[ "$B_PUT" = "implicitDeny" ]; check $? "boundary sim: s3:PutObject denied (granted by policy, outside boundary)"
[ "$B_IAM" = "implicitDeny" ]; check $? "boundary sim: iam:CreateUser denied (granted by nothing)"

# ---- 3. always-on exhibit API (works in both modes) ----
# A freshly deployed /api/* behavior + Lambda permission can 500/404 for a
# minute or two (CloudFront propagation + resource-policy race, plank 2/9). Warm
# up before asserting.
ST='{}'
for i in $(seq 1 18); do
  ST=$(curl -sS "$SITE/api/status")
  echo "$ST" | jq -e 'has("deployed")' > /dev/null 2>&1 && break
  sleep 5
done
echo "$ST" | jq -e 'has("deployed") and has("drill") and has("policy")' > /dev/null
check $? "exhibit API /api/status responds (deployed=$(echo "$ST" | jq -r '.deployed'))"

# policy desk — IAM is free, so this answers whether or not the season stack is up
SIM=$(curl -sS -X POST "$SITE/api/policy/simulate")
echo "$SIM" | jq -e 'any(.rows[]; .action=="s3:PutObject" and .decision=="implicitDeny")' > /dev/null
check $? "policy desk: boundary blocks s3:PutObject live"
echo "$SIM" | jq -e 'any(.rows[]; .action=="s3:GetObject" and .decision=="allowed")' > /dev/null
check $? "policy desk: s3:GetObject allowed live"

VAL=$(curl -sS -X POST "$SITE/api/policy/validate" -H 'content-type: application/json' -d '{"exhibitId":"star-passrole"}')
echo "$VAL" | jq -e 'any(.findings[]; .findingType=="SECURITY_WARNING")' > /dev/null
check $? "policy validator: flags PassRole on Resource *"
VALT=$(curl -sS -X POST "$SITE/api/policy/validate" -H 'content-type: application/json' -d '{"exhibitId":"typo-action"}')
echo "$VALT" | jq -e 'any(.findings[]; .findingType=="ERROR")' > /dev/null
check $? "policy validator: flags an invalid action name"
VALC=$(curl -sS -X POST "$SITE/api/policy/validate" -H 'content-type: application/json' -d '{"exhibitId":"clean"}')
echo "$VALC" | jq -e '[.findings[] | select(.findingType=="ERROR")] | length == 0' > /dev/null
check $? "policy validator: clean grant raises no errors"

# perimeter fence log — reads the shared edge ACL's sampled requests ($0)
FEN=$(curl -sS "$SITE/api/fence")
echo "$FEN" | jq -e '.rules | length == 3' > /dev/null
check $? "fence log returns all 3 edge rules"

# ---- 4. mode split ----
# (wc consumes all input — `grep -q` here would SIGPIPE terraform under pipefail)
DEMO_RESOURCES=$($TFD state list 2>/dev/null | wc -l | tr -d ' ')
if [ "$DEMO_RESOURCES" -gt 0 ]; then
  echo "— demo stack DEPLOYED: verifying live exhibits —"

  TRAIL=$($TFD output -raw trail_name)
  DETECTOR=$($TFD output -raw detector_id)
  PACK=$($TFD output -raw conformance_pack)
  ROLE=$($TF output -raw boundary_role)   # boundary role is always-on now (infra root)

  aws cloudtrail get-trail-status --name "$TRAIL" --query 'IsLogging' --output text | grep -qi true || [ $? -eq 141 ]
  check $? "CloudTrail is logging right now"
  T=$(aws cloudtrail describe-trails --trail-name-list "$TRAIL" --query 'trailList[0]' --output json)
  echo "$T" | jq -e '.IsMultiRegionTrail and .LogFileValidationEnabled and (.KmsKeyId | length > 0)' > /dev/null
  check $? "trail is multi-region + validated + KMS-encrypted"

  KEY=$(echo "$T" | jq -r '.KmsKeyId')
  aws kms get-key-rotation-status --key-id "$KEY" --query 'KeyRotationEnabled' --output text | grep -qi true || [ $? -eq 141 ]
  check $? "KMS key rotation enabled on the trail key"

  aws guardduty get-detector --detector-id "$DETECTOR" --query 'Status' --output text | grep -q ENABLED || [ $? -eq 141 ]
  check $? "GuardDuty detector ENABLED"
  N=$(aws guardduty list-findings --detector-id "$DETECTOR" --max-results 50 --query 'length(FindingIds)' --output text)
  [ "$N" -gt 0 ]; check $? "GuardDuty has findings to aggregate ($N+ listed)"

  # Security Hub's subscription status can sit at PENDING for 20+ min while
  # controls provision even though control findings are already flowing, so
  # assert the meaningful outcome (subscribed + producing findings), not the
  # transient status string.
  SH_STATUS=$(aws securityhub get-enabled-standards --query 'StandardsSubscriptions[0].StandardsStatus' --output text)
  echo "$SH_STATUS" | grep -qE 'READY|PENDING|INCOMPLETE' || [ $? -eq 141 ]
  check $? "Security Hub FSBP standard subscribed (status=$SH_STATUS)"
  SH_N=$(aws securityhub get-findings \
    --filters '{"ProductName":[{"Value":"Security Hub","Comparison":"EQUALS"}]}' \
    --max-results 1 --query 'length(Findings)' --output text 2>/dev/null || echo 0)
  [ "$SH_N" -gt 0 ]; check $? "Security Hub is producing control findings"

  aws configservice describe-configuration-recorder-status --query 'ConfigurationRecordersStatus[0].recording' --output text | grep -qi true || [ $? -eq 141 ]
  check $? "Config recorder is recording"
  PACK_STATE=$(aws configservice describe-conformance-pack-status --conformance-pack-names "$PACK" \
    --query 'ConformancePackStatusDetails[0].ConformancePackState' --output text)
  [ "$PACK_STATE" = "CREATE_COMPLETE" ]; check $? "NIST 800-53 conformance pack deployed ($PACK_STATE)"

  # live simulation, straight from IAM — not just the report's claim
  ACCT=$(aws sts get-caller-identity --query Account --output text)
  BUCKET=$($TF output -raw site_bucket)
  DEC=$(aws iam simulate-principal-policy \
    --policy-source-arn "arn:aws:iam::$ACCT:role/$ROLE" \
    --action-names s3:PutObject \
    --resource-arns "arn:aws:s3:::$BUCKET/evidence/status.json" \
    --query 'EvaluationResults[0].EvalDecision' --output text)
  [ "$DEC" = "implicitDeny" ]; check $? "live IAM simulation: boundary blocks s3:PutObject ($DEC)"

  # evidence is fresh for a live stack
  AGE_H=$(( ( $(date -u +%s) - $(date -u -j -f "%Y-%m-%dT%H:%M:%S" "$(echo "$EV" | jq -r '.generatedAt' | cut -c1-19)" +%s) ) / 3600 ))
  [ "$AGE_H" -lt 24 ]; check $? "evidence.json fresh (${AGE_H}h old)"

  echo "$STATUS" | jq -e '.deployed == true' > /dev/null; check $? "status.json says deployed"

  # the smoke field guide is built from live GuardDuty findings
  echo "$EV" | jq -e '.guardduty.fieldGuide | length > 0' > /dev/null
  check $? "evidence carries the smoke field guide ($(echo "$EV" | jq -r '.guardduty.distinctTypes') types)"

  # the season ledger accumulated at least this window
  LG=$(curl -sS "$SITE/evidence/seasons/index.json")
  echo "$LG" | jq -e '.seasons | length > 0' > /dev/null
  check $? "season ledger index has $(echo "$LG" | jq -r '.seasons | length') window(s)"

  # ---- the live practice-smoke drill ----
  echo "$ST" | jq -e '.deployed == true' > /dev/null; check $? "exhibit API sees the season stack deployed"
  SANDBOX=$($TFD output -raw sandbox_sg_id)
  RESP=$(curl -sS -X POST "$SITE/api/drills")
  RUNID=$(echo "$RESP" | jq -r '.runId // empty')
  [ -n "$RUNID" ]; check $? "drill accepted ($RUNID · $(echo "$RESP" | jq -r '.round')/$(echo "$RESP" | jq -r '.limit'))"

  if [ -n "$RUNID" ]; then
    echo "  … watching the drill (tripwire delivery + Config lag; up to ~7 min)"
    DSTATE=""
    for i in $(seq 1 84); do
      sleep 5
      R=$(curl -sS "$SITE/api/drills/$RUNID")
      echo "$R" | jq empty 2>/dev/null || continue   # skip a transient WAF HTML block page
      DSTATE=$(echo "$R" | jq -r '.run.status // empty')
      [ "$DSTATE" = "passed" ] || [ "$DSTATE" = "failed" ] && break
    done
    [ "$DSTATE" = "passed" ]; check $? "drill completed (status=$DSTATE)"
    CLOSED_BY=$(curl -sS "$SITE/api/drills/$RUNID" | jq -r '.run.summary.closedBy // "unknown"')
    ok "drill closed the hole by: $CLOSED_BY"
  fi

  # whatever closed it, the sandbox must end with no world-open SSH
  OPEN=$(aws ec2 describe-security-groups --group-ids "$SANDBOX" \
    --query "length(SecurityGroups[0].IpPermissions[?FromPort==\`22\`])" --output text 2>/dev/null || echo "err")
  [ "$OPEN" = "0" ]; check $? "sandbox group left closed after the drill (open ingress rules: $OPEN)"
else
  echo "— demo stack TORN DOWN: proving the idle state —"

  [ "$(aws guardduty list-detectors --query 'length(DetectorIds)' --output text)" = "0" ]
  check $? "no GuardDuty detector (nothing billing)"
  aws securityhub describe-hub > /dev/null 2>&1 && bad "Security Hub still subscribed" || ok "Security Hub not subscribed (nothing billing)"
  [ "$(aws configservice describe-configuration-recorders --query 'length(ConfigurationRecorders)' --output text)" = "0" ]
  check $? "no Config recorder (nothing billing)"
  [ "$(aws cloudtrail describe-trails --query 'length(trailList)' --output text)" = "0" ]
  check $? "no CloudTrail trail left behind"
  echo "$STATUS" | jq -e '.deployed == false' > /dev/null; check $? "status.json says torn down"

  # the exhibit API stays up (always-on root); the drill honestly refuses
  echo "$ST" | jq -e '.deployed == false' > /dev/null; check $? "exhibit API reports the season stack torn down"
  DR=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/api/drills")
  [ "$DR" = "503" ]; check $? "drill POST returns 503 between windows (got $DR)"
fi

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" = "0" ]
