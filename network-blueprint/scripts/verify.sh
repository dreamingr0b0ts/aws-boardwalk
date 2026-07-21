#!/usr/bin/env bash
# End-to-end verification for the deploy-demo-teardown plank. Runs in two
# modes, decided by whether the demo root has state:
#   DEPLOYED  → verify every exhibit live (VPC, instances, endpoints, flow
#               logs, Reachability Analyzer) + fresh evidence
#   TORN DOWN → verify the always-on half AND prove the idle state: no
#               instances, no interface endpoints, no VPC left billing
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
HDRS=$(curl -sS -D - -o /tmp/net-index.html "$SITE/" | tr -d '\r')
grep -q "Alpenglow Network Blueprint" /tmp/net-index.html; check $? "site serves the Network Blueprint page"
echo "$HDRS" | grep -qi "strict-transport-security" || [ $? -eq 141 ]; check $? "HSTS header present"
echo "$HDRS" | grep -qi "content-security-policy" || [ $? -eq 141 ]; check $? "CSP header present"

# ---- 2. always-on: persisted evidence artifacts ----
STATUS=$(curl -sS "$SITE/evidence/status.json")
echo "$STATUS" | jq -e 'has("deployed")' > /dev/null; check $? "status.json served (deployed=$(echo "$STATUS" | jq -r '.deployed'))"
EV=$(curl -sS "$SITE/evidence/evidence.json")
echo "$EV" | jq -e '.generatedAt and .network and .securityTiers and .nacls and .endpoints and .flowLogs and .probes and .reachability' > /dev/null
check $? "evidence.json has every exhibit section"
curl -sS "$SITE/evidence/evidence.html" | grep -q "Network Blueprint Evidence Report" || [ $? -eq 141 ]
check $? "standalone evidence.html served through CloudFront"

# routing: the no-NAT pattern
echo "$EV" | jq -e '.network.routing.publicDefaultViaIgw == true' > /dev/null
check $? "evidence: public default route via the IGW"
echo "$EV" | jq -e '.network.routing.privateDefaultRoutes == 0' > /dev/null
check $? "evidence: private route tables have ZERO default routes"
echo "$EV" | jq -e '.network.routing.natGateways == 0' > /dev/null
check $? "evidence: no NAT gateways anywhere"
echo "$EV" | jq -e '.endpoints.gatewayAvailable == 2' > /dev/null
check $? "evidence: both gateway endpoints (S3, DynamoDB) available"
echo "$EV" | jq -e '.endpoints.interfaceAvailable == 3' > /dev/null
check $? "evidence: all three SSM interface endpoints available"

# reachability analyzer: designed-reachable AND designed-unreachable both hold
r_pass() {
  echo "$EV" | jq -e --arg k "$1" '.reachability[] | select(.key==$k) | .pass == true' > /dev/null
  check $? "analyzer: $2"
}
r_pass igw-to-web-443  "internet → web :443 reachable (as designed)"
r_pass igw-to-app-8080 "internet → app :8080 NOT reachable (as designed)"
r_pass web-to-app-8080 "web → app :8080 reachable (as designed)"
r_pass web-to-app-5432 "web → app :5432 NOT reachable (as designed)"

# live probes from the instances themselves
p_pass() {
  echo "$EV" | jq -e --arg n "$1" '.probes[] | select(.name==$n) | .pass == true' > /dev/null
  check $? "probe: $2"
}
p_pass private-internet-egress "private instance can NOT reach the internet"
p_pass private-s3-gateway      "private instance reaches S3 via the gateway endpoint"
p_pass private-ddb-gateway     "private instance reaches DynamoDB via the gateway endpoint"
p_pass imdsv1-blocked          "IMDSv1 rejected with 401"
p_pass imdsv2-works            "IMDSv2 answers with the instance id"
p_pass public-internet-egress  "public instance reaches the internet via the IGW"
p_pass web-to-app-8080         "web tier reaches the app listener on 8080"
p_pass web-to-data-5432        "web tier blocked on 5432 by the app SG"

# layered defenses
echo "$EV" | jq -e '.securityTiers.defaultSgLocked == true' > /dev/null
check $? "evidence: default security group locked (zero rules)"
echo "$EV" | jq -e '.nacls.deny3389 == true' > /dev/null
check $? "evidence: NACL explicit deny for RDP 3389"
echo "$EV" | jq -e '.flowLogs.active and .flowLogs.totalEvents > 0' > /dev/null
check $? "evidence: flow logs active with records captured ($(echo "$EV" | jq -r '.flowLogs.totalEvents') in window, $(echo "$EV" | jq -r '.flowLogs.reject') rejected)"

# ---- 3. mode split ----
# (wc consumes all input — `grep -q` here would SIGPIPE terraform under pipefail)
DEMO_RESOURCES=$($TFD state list 2>/dev/null | wc -l | tr -d ' ')
if [ "$DEMO_RESOURCES" -gt 0 ]; then
  echo "— demo stack DEPLOYED: verifying live exhibits —"

  VPC=$($TFD output -raw vpc_id)

  N=$(aws ec2 describe-instances \
    --filters "Name=vpc-id,Values=$VPC" "Name=instance-state-name,Values=running" \
    --query 'length(Reservations[].Instances[])' --output text)
  [ "$N" = "2" ]; check $? "both instances running ($N/2)"

  N=$(aws ec2 describe-vpc-endpoints --filters "Name=vpc-id,Values=$VPC" "Name=vpc-endpoint-state,Values=available" \
    --query 'length(VpcEndpoints)' --output text)
  [ "$N" = "5" ]; check $? "5 VPC endpoints available live (2 gateway + 3 interface)"

  aws ec2 describe-flow-logs --filter "Name=resource-id,Values=$VPC" \
    --query 'FlowLogs[0].FlowLogStatus' --output text | grep -q ACTIVE || [ $? -eq 141 ]
  check $? "VPC flow log ACTIVE right now"

  N=$(aws ec2 describe-network-insights-analyses \
    --filters "Name=tag:env,Values=network-blueprint" \
    --query 'length(NetworkInsightsAnalyses[?Status==`succeeded`])' --output text)
  [ "$N" = "4" ]; check $? "all 4 Reachability Analyzer analyses succeeded ($N/4)"

  N=$(aws ssm describe-instance-information \
    --filters "Key=tag:env,Values=network-blueprint" \
    --query 'length(InstanceInformationList[?PingStatus==`Online`])' --output text)
  [ "$N" = "2" ]; check $? "both instances Online in SSM (private one via PrivateLink)"

  # evidence is fresh for a live stack
  AGE_H=$(( ( $(date -u +%s) - $(date -u -j -f "%Y-%m-%dT%H:%M:%S" "$(echo "$EV" | jq -r '.generatedAt' | cut -c1-19)" +%s) ) / 3600 ))
  [ "$AGE_H" -lt 24 ]; check $? "evidence.json fresh (${AGE_H}h old)"

  echo "$STATUS" | jq -e '.deployed == true' > /dev/null; check $? "status.json says deployed"
else
  echo "— demo stack TORN DOWN: proving the idle state —"

  N=$(aws ec2 describe-instances \
    --filters "Name=tag:env,Values=network-blueprint" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'length(Reservations[].Instances[])' --output text)
  [ "$N" = "0" ]; check $? "no instances left (nothing billing)"

  N=$(aws ec2 describe-vpc-endpoints --filters "Name=tag:env,Values=network-blueprint" \
    --query 'length(VpcEndpoints)' --output text)
  [ "$N" = "0" ]; check $? "no VPC endpoints left (no PrivateLink billing)"

  N=$(aws ec2 describe-vpcs --filters "Name=tag:env,Values=network-blueprint" \
    --query 'length(Vpcs)' --output text)
  [ "$N" = "0" ]; check $? "no VPC left behind"

  N=$(aws ec2 describe-flow-logs --filter "Name=tag:env,Values=network-blueprint" \
    --query 'length(FlowLogs)' --output text)
  [ "$N" = "0" ]; check $? "no flow logs left"

  N=$(aws logs describe-log-groups --log-group-name-prefix "/aws/vpc/net-flow-logs" \
    --query 'length(logGroups)' --output text)
  [ "$N" = "0" ]; check $? "flow-log log group removed (no storage accruing)"

  echo "$STATUS" | jq -e '.deployed == false' > /dev/null; check $? "status.json says torn down"
fi

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" = "0" ]
