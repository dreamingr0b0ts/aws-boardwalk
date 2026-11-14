#!/usr/bin/env bash
# End-to-end verification of the DevOps/SRE plank against the LIVE account.
# The plank isn't done until every check here passes — including proof that
# the pipeline is keyless, the canary is parked, and the drill actually ran.
set -uo pipefail
cd "$(dirname "$0")/.."

TF="terraform -chdir=infra"
SITE=$($TF output -raw site_url)
PLAN_ROLE=$($TF output -raw gh_plan_role_arn)
APPLY_ROLE=$($TF output -raw gh_apply_role_arn)
CANARY=$($TF output -raw canary_name)
SFN_ARN=$($TF output -raw runbook_state_machine_arn)
TOPIC=$($TF output -raw alerts_topic_arn)
REPO="dreamingr0b0ts/aws-boardwalk"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
check(){ if [ "$1" = "0" ]; then ok "$2"; else bad "$2"; fi }

echo "verifying $SITE"

# ---- 1. status page + security headers ----
HDRS=$(curl -sS -D - -o /tmp/ops-index.html "$SITE/" | tr -d '\r')
grep -q "The environment that builds the others" /tmp/ops-index.html; check $? "status page serves"
echo "$HDRS" | grep -qi "strict-transport-security" || [ $? -eq 141 ]; check $? "HSTS header present"
echo "$HDRS" | grep -qi "content-security-policy" || [ $? -eq 141 ]; check $? "CSP header present"

# ---- 2. keyless CI: OIDC provider + role trust shape ----
aws iam list-open-id-connect-providers --output text \
  | grep -q "token.actions.githubusercontent.com" || [ $? -eq 141 ]; check $? "GitHub OIDC identity provider exists"

PLAN_TRUST=$(aws iam get-role --role-name "${PLAN_ROLE##*/}" --query 'Role.AssumeRolePolicyDocument' --output json)
echo "$PLAN_TRUST" | grep -q "repo:$REPO:pull_request" || [ $? -eq 141 ]; check $? "plan role trusts this repo's pull requests"
aws iam list-attached-role-policies --role-name "${PLAN_ROLE##*/}" --output text \
  | grep -q "ReadOnlyAccess" || [ $? -eq 141 ]; check $? "plan role is read-only"

APPLY_TRUST=$(aws iam get-role --role-name "${APPLY_ROLE##*/}" --query 'Role.AssumeRolePolicyDocument' --output json)
echo "$APPLY_TRUST" | grep -q "repo:$REPO:environment:prod" || [ $? -eq 141 ]; check $? "apply role only assumable via the prod environment"
aws iam get-role-policy --role-name "${APPLY_ROLE##*/}" --policy-name plank-iam --output json \
  | grep -q "NeverSelfModify" || [ $? -eq 141 ]; check $? "apply role cannot modify its own IAM"

# The fence is proven, not grepped: ask IAM what the apply role's live
# policies would decide. `decide ACTION RESOURCE [BOUNDARY_ARN]` simulates the
# call, optionally as if the target role carried (or the request named) that
# permissions boundary.
ACCT=$(echo "$APPLY_ROLE" | cut -d: -f5)
BOUNDARY="arn:aws:iam::$ACCT:policy/boardwalk-role-boundary"
decide() {
  local ctx=()
  [ -n "${3:-}" ] && ctx=(--context-entries "ContextKeyName=iam:PermissionsBoundary,ContextKeyValues=$3,ContextKeyType=string")
  # ${ctx[@]+...}: macOS still ships bash 3.2, where expanding an empty array
  # under `set -u` is an "unbound variable" error.
  aws iam simulate-principal-policy --policy-source-arn "$APPLY_ROLE" --action-names "$1" \
    --resource-arns "$2" ${ctx[@]+"${ctx[@]}"} --query 'EvaluationResults[0].EvalDecision' --output text --no-cli-pager
}
PROBE="arn:aws:iam::$ACCT:role/mwa-verify-probe"
[ "$(decide iam:CreateRole "$PROBE")" = "implicitDeny" ]; check $? "apply role cannot create a role without the boundary"
[ "$(decide iam:CreateRole "$PROBE" "$BOUNDARY")" = "allowed" ]; check $? "apply role can create a plank role under the boundary"
[ "$(decide iam:AttachRolePolicy "$PROBE")" = "implicitDeny" ]; check $? "apply role cannot attach policies to an unbounded role"
[ "$(decide iam:DeleteRolePermissionsBoundary "$PROBE" "$BOUNDARY")" = "implicitDeny" ]; check $? "apply role cannot strip a boundary"
[ "$(decide iam:CreatePolicyVersion "$BOUNDARY")" = "explicitDeny" ]; check $? "apply role cannot rewrite the boundary policy"
[ "$(decide sts:AssumeRole "arn:aws:iam::111122223333:role/OrganizationAccountAccessRole")" = "explicitDeny" ]; check $? "apply role cannot assume a role in another account"
[ "$(decide route53:DeleteHostedZone "*")" = "explicitDeny" ]; check $? "apply role cannot delete a hosted zone"

# Every role the boardwalk owns carries a boundary (the CI roles are managed
# by hand and are the only exception).
UNBOUNDED=$(aws iam list-roles --query 'Roles[?!starts_with(Path, `/aws-service-role/`)].RoleName' --output text --no-cli-pager \
  | tr '\t' '\n' | grep -v '^ops-gh-' | while read -r R; do
      B=$(aws iam get-role --role-name "$R" --query 'Role.PermissionsBoundary.PermissionsBoundaryArn' --output text --no-cli-pager)
      [ "$B" = "None" ] && echo "$R"
    done)
[ -z "$UNBOUNDED" ]; check $? "every boardwalk role carries a permissions boundary${UNBOUNDED:+ (missing: $(echo $UNBOUNDED | tr '\n' ' '))}"

# No long-lived AWS keys anywhere in the repo or workflows.
! grep -rE "AKIA[0-9A-Z]{16}" ../.github ../*/infra --include='*.yml' --include='*.tf' -q 2>/dev/null
check $? "no AWS access keys anywhere in workflows or terraform"

# ---- 3. pipeline is real: latest run on main ----
RUNS=$(curl -sS "https://api.github.com/repos/$REPO/actions/workflows/terraform.yml/runs?branch=main&per_page=1")
LATEST=$(echo "$RUNS" | jq -r '.workflow_runs[0].conclusion // "none"')
[ "$LATEST" = "success" ]; check $? "latest terraform workflow run on main: $LATEST"

# ---- 4. observability ----
aws cloudwatch get-dashboard --dashboard-name ops-boardwalk --query DashboardName --output text > /dev/null 2>&1
check $? "ops-boardwalk dashboard exists"

ALARMS=$(aws cloudwatch describe-alarms --alarm-name-prefix ops- --query 'length(MetricAlarms)' --output text)
[ "$ALARMS" -ge 4 ]; check $? "alarms wired ($ALARMS ops-* alarms)"

SUBS=$(aws sns list-subscriptions-by-topic --topic-arn "$TOPIC" --query 'Subscriptions[0].Protocol' --output text)
[ "$SUBS" = "email" ]; check $? "alerts topic has an email subscription"

# ---- 5. canary exists and is PARKED (idle cost ≈ $0) ----
CSTATE=$(aws synthetics get-canary --name "$CANARY" --query 'Canary.Status.State' --output text)
[ "$CSTATE" = "STOPPED" ] || [ "$CSTATE" = "READY" ]; check $? "heartbeat canary exists and is parked ($CSTATE)"

# ---- 6. the drill has run and published evidence ----
LATEST_EXEC=$(aws stepfunctions list-executions --state-machine-arn "$SFN_ARN" \
  --status-filter SUCCEEDED --max-results 1 --query 'executions[0].name' --output text)
[ -n "$LATEST_EXEC" ] && [ "$LATEST_EXEC" != "None" ]; check $? "backup/restore drill has a SUCCEEDED execution ($LATEST_EXEC)"

REPORT=$(curl -sS "$SITE/runbook/latest.json")
[ "$(echo "$REPORT" | jq -r '.result')" = "PASS" ]; check $? "published drill report says PASS"
RTO=$(echo "$REPORT" | jq -r '.rtoSeconds')
[ "$RTO" -gt 0 ] 2>/dev/null; check $? "report contains a measured RTO (${RTO}s)"

# Drill leaves nothing behind: scratch table gone, no lingering backups.
! aws dynamodb describe-table --table-name ops-restore-drill > /dev/null 2>&1
check $? "scratch restore table cleaned up"
NBACKUPS=$(aws dynamodb list-backups --table-name "$(echo "$REPORT" | jq -r '.sourceTable')" \
  --query 'length(BackupSummaries)' --output text)
[ "$NBACKUPS" = "0" ]; check $? "no leftover on-demand backups"

# ---- 7. X-Ray posture on the runbook pieces ----
TRACING=$(aws lambda get-function-configuration --function-name ops-runbook-verify \
  --query 'TracingConfig.Mode' --output text)
[ "$TRACING" = "Active" ]; check $? "runbook Lambda has X-Ray active tracing"

# ---- 8. live exhibits: status, sweep log, season ledger ----
# Note: this section spends 1 of the day's 10 drills and 1 of its 30 sweeps.
grep -q 'script-src .self.' <(curl -sS -D - -o /dev/null "$SITE/") || [ $? -eq 141 ]
check $? "CSP allows only same-origin script (no inline)"
curl -sS "$SITE/app.js" | head -c 200 | grep -q "Boardwalk Ops page script" || [ $? -eq 141 ]
check $? "app.js served from the site origin"

STATUS=$(curl -sS "$SITE/api/status")
[ "$(echo "$STATUS" | jq -r '.sites')" = "13" ]; check $? "exhibit API answers; sweep covers 13 sites"
[ "$(echo "$STATUS" | jq -r '.drill.limit')" = "10" ] && [ "$(echo "$STATUS" | jq -r '.sweep.limit')" = "30" ]
check $? "day-book caps wired (10 drills / 30 sweeps)"

CI=$(curl -sS "$SITE/api/ci")
[ "$(echo "$CI" | jq '.runs | length')" -ge 1 ] 2>/dev/null; check $? "sweep log lists pipeline runs from GitHub"
echo "$CI" | jq -e '.legs.plan.total >= 1' > /dev/null 2>&1; check $? "sweep log aggregates the latest run's legs"

COST=$(curl -sS "$SITE/api/cost")
for _ in 1 2 3 4; do
  echo "$COST" | jq -e '.total' > /dev/null 2>&1 && break
  sleep 5; COST=$(curl -sS "$SITE/api/cost")
done
echo "$COST" | jq -e '.total >= 0' > /dev/null 2>&1; check $? "season ledger has a month-to-date total (\$$(echo "$COST" | jq -r '.total'))"
[ "$(echo "$COST" | jq '.byService | length')" -ge 1 ] 2>/dev/null; check $? "season ledger breaks the bill down by service"

# ---- 9. the closing sweep, end to end ----
SW=$(curl -sS -X POST "$SITE/api/sweep")
SWID=$(echo "$SW" | jq -r '.runId // empty')
[ -n "$SWID" ]; check $? "closing sweep dispatched ($SWID)"
if [ -n "$SWID" ]; then
  SW2=$(curl -sS -X POST "$SITE/api/sweep")
  [ "$(echo "$SW2" | jq -r '.runId // empty')" = "$SWID" ]
  check $? "second sweep POST gets a 409 carrying the sweep under way"
  SWDONE=""
  for _ in $(seq 1 30); do
    sleep 3
    SWRUN=$(curl -sS "$SITE/api/sweep/$SWID")
    SWDONE=$(echo "$SWRUN" | jq -r '.status')
    [ "$SWDONE" = "running" ] || break
  done
  [ "$SWDONE" = "done" ]; check $? "sweep completed ($SWDONE)"
  SWOK=$(echo "$SWRUN" | jq -r '.summary.ok')
  [ "$SWOK" = "$(echo "$SWRUN" | jq -r '.summary.total')" ]
  check $? "sweep found every site clear ($SWOK of $(echo "$SWRUN" | jq -r '.summary.total'))"
else
  bad "sweep 409/completion checks skipped (no runId)"
fi

# ---- 10. the beacon drill through the visitor lever ----
DR=$(curl -sS -X POST "$SITE/api/drill")
DID=$(echo "$DR" | jq -r '.runId // empty')
[ -n "$DID" ]; check $? "beacon drill dispatched ($DID)"
if [ -n "$DID" ]; then
  DR2=$(curl -sS -X POST "$SITE/api/drill")
  [ "$(echo "$DR2" | jq -r '.runId // empty')" = "$DID" ]
  check $? "second drill POST gets a 409 carrying the drill under way"
  DSTATUS=""
  for _ in $(seq 1 40); do
    sleep 15
    DRUN=$(curl -sS "$SITE/api/drill/$DID")
    DSTATUS=$(echo "$DRUN" | jq -r '.status')
    [ "$DSTATUS" = "RUNNING" ] || break
  done
  [ "$DSTATUS" = "SUCCEEDED" ]; check $? "visitor drill succeeded ($DSTATUS)"
  [ "$(echo "$DRUN" | jq -r '.report.result')" = "PASS" ]; check $? "visitor drill report says PASS"
  [ "$(echo "$DRUN" | jq '[.stages[] | select(.status == "done")] | length')" = "4" ]
  check $? "all four drill stages read done from the execution history"
  [ "$(curl -sS "$SITE/runbook/latest.json" | jq -r '.execution')" = "web-$DID" ]
  check $? "visitor drill published as the drill of record"
  # DeleteTable is async; the scratch table sits in DELETING briefly.
  GONE=1
  for _ in $(seq 1 12); do
    if ! aws dynamodb describe-table --table-name ops-restore-drill > /dev/null 2>&1; then GONE=0; break; fi
    sleep 10
  done
  [ "$GONE" = "0" ]; check $? "visitor drill packed out the scratch table"
else
  bad "drill 409/completion checks skipped (no runId)"
fi

# ---- the account's own record: audit trail, analyzer, tripwires ----
# Always on, unlike plank 8's demo stack. Config is read back from the live
# account; the fence around it is simulated, not grepped (decide, above).
TRAIL=$($TF output -raw audit_trail_name)
AUDIT_BUCKET=$($TF output -raw audit_bucket)
ANALYZER=$($TF output -raw access_analyzer_arn)

TSTATUS=$(aws cloudtrail get-trail-status --name "$TRAIL" --output json --no-cli-pager)
[ "$(echo "$TSTATUS" | jq -r '.IsLogging')" = "true" ]; check $? "audit trail is logging"
[ -z "$(echo "$TSTATUS" | jq -r '.LatestDeliveryError // empty')" ]; check $? "audit trail's last delivery to S3 had no error"
TDESC=$(aws cloudtrail describe-trails --trail-name-list "$TRAIL" --query 'trailList[0]' --output json --no-cli-pager)
echo "$TDESC" | jq -e '.IsMultiRegionTrail and .IncludeGlobalServiceEvents and .LogFileValidationEnabled' > /dev/null
check $? "audit trail covers every region and global services, with log-file validation"
TRAIL_ARN=$(echo "$TDESC" | jq -r '.TrailARN')

aws s3api get-public-access-block --bucket "$AUDIT_BUCKET" --query PublicAccessBlockConfiguration --output json --no-cli-pager \
  | jq -e '[.[]] | length == 4 and all' > /dev/null; check $? "audit bucket blocks public access"
[ "$(aws s3api get-bucket-versioning --bucket "$AUDIT_BUCKET" --query Status --output text --no-cli-pager)" = "Enabled" ]
check $? "audit bucket keeps overwritten or deleted log files (versioning)"
# A log file under today's or yesterday's date (UTC): the trail is not just
# switched on, it is delivering. date -v is macOS, date -d is GNU.
DELIVERED=0
for DAY in "$(date -u +%Y/%m/%d)" "$(date -u -v-1d +%Y/%m/%d 2>/dev/null || date -u -d yesterday +%Y/%m/%d)"; do
  NLOGS=$(aws s3api list-objects-v2 --bucket "$AUDIT_BUCKET" --prefix "AWSLogs/$ACCT/CloudTrail/us-east-1/$DAY/" \
    --max-keys 1 --query KeyCount --output text --no-cli-pager)
  [ "$NLOGS" -ge 1 ] 2>/dev/null && DELIVERED=1
done
[ "$DELIVERED" = "1" ]; check $? "audit bucket holds log files delivered in the last day"

aws s3control get-public-access-block --account-id "$ACCT" --query PublicAccessBlockConfiguration --output json --no-cli-pager \
  | jq -e '[.[]] | length == 4 and all' > /dev/null; check $? "account-wide S3 public access block: all four switches on"

[ "$(aws accessanalyzer get-analyzer --analyzer-name "${ANALYZER##*/}" --query analyzer.status --output text --no-cli-pager)" = "ACTIVE" ]
check $? "access analyzer is active"
# The three CI roles trust GitHub's identity provider, so they are reachable
# from outside by design. Any other active finding is something to look at.
UNEXPECTED=$(aws accessanalyzer list-findings --analyzer-arn "$ANALYZER" --filter '{"status":{"eq":["ACTIVE"]}}' \
  --query 'findings[].resource' --output text --no-cli-pager | tr '\t' '\n' | grep -v ':role/ops-gh-' | grep -v '^$' | sort -u)
[ -z "$UNEXPECTED" ]; check $? "access analyzer: nothing reachable from outside the account but the CI roles${UNEXPECTED:+ (unexpected: $(echo $UNEXPECTED))}"

# GuardDuty: on, with exactly the protection plans the Terraform states. The
# paid extras (malware scans, runtime agents, RDS, EKS) must read DISABLED,
# because a new detector enables some of them by default and they are where a
# GuardDuty bill grows.
GD=$($TF output -raw guardduty_detector_id)
GDESC=$(aws guardduty get-detector --detector-id "$GD" --output json --no-cli-pager)
[ "$(echo "$GDESC" | jq -r '.Status')" = "ENABLED" ]; check $? "GuardDuty detector is enabled"
feature() { echo "$GDESC" | jq -r --arg n "$1" '.Features[] | select(.Name == $n) | .Status'; }
[ "$(feature S3_DATA_EVENTS)" = "ENABLED" ] && [ "$(feature LAMBDA_NETWORK_LOGS)" = "ENABLED" ]
check $? "GuardDuty watches S3 data events and Lambda network activity"
GD_EXTRAS=$(echo "$GDESC" | jq -r '[.Features[] | select(.Status == "ENABLED") | .Name] - ["CLOUD_TRAIL", "DNS_LOGS", "FLOW_LOGS", "S3_DATA_EVENTS", "LAMBDA_NETWORK_LOGS"] | join(" ")')
[ -z "$GD_EXTRAS" ]; check $? "no paid GuardDuty extras are switched on${GD_EXTRAS:+ (enabled: $GD_EXTRAS)}"
# Whatever is active in the detector should be real. Practice findings belong
# to plank 8's demo window and are archived when it closes.
GD_OPEN=$(aws guardduty list-findings --detector-id "$GD" --max-items 50 --no-cli-pager \
  --finding-criteria '{"Criterion":{"service.archived":{"Eq":["false"]}}}' --query 'length(FindingIds)' --output text)
ok "GuardDuty active findings right now: $GD_OPEN (each one was mailed when it was raised)"

ALERT_RULES=$(aws events list-rules --name-prefix ops-alert- --query 'Rules[?State==`ENABLED`].Name' --output text --no-cli-pager)
[ "$(echo $ALERT_RULES | wc -w | tr -d ' ')" = "7" ]; check $? "seven account alert rules enabled ($(echo $ALERT_RULES | wc -w | tr -d ' '))"
UNWIRED=""
for R in $ALERT_RULES; do
  T=$(aws events list-targets-by-rule --rule "$R" --query 'Targets[0].Arn' --output text --no-cli-pager)
  [ "$T" = "$TOPIC" ] || UNWIRED="$UNWIRED $R"
done
[ -z "$UNWIRED" ]; check $? "every alert rule mails the alerts topic${UNWIRED:+ (not wired:$UNWIRED)}"
aws sns get-topic-attributes --topic-arn "$TOPIC" --query Attributes.Policy --output text --no-cli-pager \
  | jq -e '.Statement | any(.Principal.Service? == "events.amazonaws.com" and .Action == "sns:Publish")' > /dev/null
check $? "alerts topic lets the alert rules publish"
[ "$(aws sns list-subscriptions-by-topic --topic-arn "$TOPIC" --query 'Subscriptions[0].SubscriptionArn' --output text --no-cli-pager | cut -d: -f1)" = "arn" ]
check $? "alert email subscription is confirmed"

# The pipeline reads the record and cannot touch it.
[ "$(decide cloudtrail:StopLogging "$TRAIL_ARN")" = "explicitDeny" ]; check $? "apply role cannot stop the audit trail"
[ "$(decide cloudtrail:DeleteTrail "$TRAIL_ARN")" = "explicitDeny" ]; check $? "apply role cannot delete the audit trail"
[ "$(decide s3:DeleteObject "arn:aws:s3:::$AUDIT_BUCKET/AWSLogs/probe")" = "explicitDeny" ]; check $? "apply role cannot delete audit log files"
[ "$(decide s3:PutBucketPolicy "arn:aws:s3:::$AUDIT_BUCKET")" = "explicitDeny" ]; check $? "apply role cannot rewrite the audit bucket's policy"
[ "$(decide s3:PutAccountPublicAccessBlock "*")" = "explicitDeny" ]; check $? "apply role cannot lift the account-wide public access block"
[ "$(decide access-analyzer:DeleteAnalyzer "$ANALYZER")" = "explicitDeny" ]; check $? "apply role cannot delete the access analyzer"
[ "$(decide events:DisableRule "arn:aws:events:us-east-1:$ACCT:rule/ops-alert-root-activity")" = "explicitDeny" ]; check $? "apply role cannot disable an alert rule"
[ "$(decide s3:GetBucketPolicy "arn:aws:s3:::$AUDIT_BUCKET")" = "allowed" ]; check $? "apply role can still read it all (drift shows up in CI's plan)"
[ "$(decide cloudtrail:DeleteTrail "arn:aws:cloudtrail:us-east-1:$ACCT:trail/sec-trail")" = "allowed" ]; check $? "apply role can still tear down plank 8's demo trail (the nightly sweep)"
GD_ARN="arn:aws:guardduty:us-east-1:$ACCT:detector/$GD"
[ "$(decide guardduty:DeleteDetector "$GD_ARN")" = "explicitDeny" ]; check $? "apply role cannot delete the GuardDuty detector"
[ "$(decide guardduty:UpdateDetector "$GD_ARN")" = "explicitDeny" ]; check $? "apply role cannot disable the detector or change its plans"
[ "$(decide guardduty:CreateFilter "$GD_ARN/filter/probe")" = "explicitDeny" ]; check $? "apply role cannot add a filter that hides findings"
# Simulated on "*": the policy simulator does not accept a detector ARN for
# the findings calls and answers implicitDeny for any role if given one.
[ "$(decide guardduty:ArchiveFindings "*")" = "allowed" ]; check $? "apply role can still archive plank 8's practice findings (the nightly sweep)"

# Nor can anything the pipeline creates: the same denies sit in the boundary.
# Simulated as the most permissive role possible (allow everything) under the
# live boundary document.
BVER=$(aws iam get-policy --policy-arn "$BOUNDARY" --query Policy.DefaultVersionId --output text --no-cli-pager)
BDOC=$(aws iam get-policy-version --policy-arn "$BOUNDARY" --version-id "$BVER" --query PolicyVersion.Document --output json --no-cli-pager)
ALLOW_ALL='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"*","Resource":"*"}]}'
under_boundary() {
  aws iam simulate-custom-policy --policy-input-list "$ALLOW_ALL" --permissions-boundary-policy-input-list "$BDOC" \
    --action-names "$1" --resource-arns "$2" --query 'EvaluationResults[0].EvalDecision' --output text --no-cli-pager
}
[ "$(under_boundary cloudtrail:StopLogging "$TRAIL_ARN")" = "explicitDeny" ]; check $? "no role under the boundary can stop the audit trail, whatever its own policy allows"
[ "$(under_boundary s3:PutObject "arn:aws:s3:::$AUDIT_BUCKET/AWSLogs/probe")" = "explicitDeny" ]; check $? "no role under the boundary can write to the audit bucket"
[ "$(under_boundary guardduty:UpdateDetector "$GD_ARN")" = "explicitDeny" ]; check $? "no role under the boundary can switch GuardDuty off"
[ "$(under_boundary s3:GetObject "arn:aws:s3:::mwa-uploads-$ACCT/probe")" = "allowed" ]; check $? "the boundary still lets plank roles do plank work"

# ---- the origin lock: the API answers CloudFront, never the open internet ----
# Straight at the execute-api hostname there is no WAF, and the caller writes
# the whole X-Forwarded-For chain the visitor caps key on. So every handler
# refuses a request that lacks the secret header only the distribution sends.
API_DIRECT=$($TF output -raw exhibits_api_endpoint)
for ROUTE in /api/status; do
  DIRECT=$(curl -sS -o /dev/null -w '%{http_code}' "$API_DIRECT$ROUTE")
  [ "$DIRECT" = "403" ]; check $? "direct call to the API origin is refused: GET $ROUTE ($DIRECT)"
done
GUESS=$(curl -sS -o /dev/null -w '%{http_code}' -H 'x-origin-verify: guess' "$API_DIRECT/api/status")
[ "$GUESS" = "403" ]; check $? "a guessed origin header is refused too ($GUESS)"
VIA=$(curl -sS -o /dev/null -w '%{http_code}' -H 'x-origin-verify: guess' "$SITE/api/status")
[ "$VIA" = "200" ]; check $? "through CloudFront a viewer-sent origin header is replaced, not trusted ($VIA)"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" = "0" ]
