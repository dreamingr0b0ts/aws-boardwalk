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

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" = "0" ]
