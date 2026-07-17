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
echo "$HDRS" | grep -qi "strict-transport-security"; check $? "HSTS header present"
echo "$HDRS" | grep -qi "content-security-policy"; check $? "CSP header present"

# ---- 2. always-on: persisted evidence artifacts ----
STATUS=$(curl -sS "$SITE/evidence/status.json")
echo "$STATUS" | jq -e 'has("deployed")' > /dev/null; check $? "status.json served (deployed=$(echo "$STATUS" | jq -r '.deployed'))"
EV=$(curl -sS "$SITE/evidence/evidence.json")
echo "$EV" | jq -e '.generatedAt and .cloudtrail and .guardduty and .securityHub and .config and .boundary' > /dev/null
check $? "evidence.json has every exhibit section"
curl -sS "$SITE/evidence/evidence.html" | grep -q "Security Posture Evidence Report"
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

# ---- 3. mode split ----
# (wc consumes all input — `grep -q` here would SIGPIPE terraform under pipefail)
DEMO_RESOURCES=$($TFD state list 2>/dev/null | wc -l | tr -d ' ')
if [ "$DEMO_RESOURCES" -gt 0 ]; then
  echo "— demo stack DEPLOYED: verifying live exhibits —"

  TRAIL=$($TFD output -raw trail_name)
  DETECTOR=$($TFD output -raw detector_id)
  PACK=$($TFD output -raw conformance_pack)
  ROLE=$($TFD output -raw boundary_role)

  aws cloudtrail get-trail-status --name "$TRAIL" --query 'IsLogging' --output text | grep -qi true
  check $? "CloudTrail is logging right now"
  T=$(aws cloudtrail describe-trails --trail-name-list "$TRAIL" --query 'trailList[0]' --output json)
  echo "$T" | jq -e '.IsMultiRegionTrail and .LogFileValidationEnabled and (.KmsKeyId | length > 0)' > /dev/null
  check $? "trail is multi-region + validated + KMS-encrypted"

  KEY=$(echo "$T" | jq -r '.KmsKeyId')
  aws kms get-key-rotation-status --key-id "$KEY" --query 'KeyRotationEnabled' --output text | grep -qi true
  check $? "KMS key rotation enabled on the trail key"

  aws guardduty get-detector --detector-id "$DETECTOR" --query 'Status' --output text | grep -q ENABLED
  check $? "GuardDuty detector ENABLED"
  N=$(aws guardduty list-findings --detector-id "$DETECTOR" --max-results 50 --query 'length(FindingIds)' --output text)
  [ "$N" -gt 0 ]; check $? "GuardDuty has findings to aggregate ($N+ listed)"

  aws securityhub get-enabled-standards --query 'StandardsSubscriptions[0].StandardsStatus' --output text | grep -q READY
  check $? "Security Hub FSBP standard READY"

  aws configservice describe-configuration-recorder-status --query 'ConfigurationRecordersStatus[0].recording' --output text | grep -qi true
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
fi

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" = "0" ]
