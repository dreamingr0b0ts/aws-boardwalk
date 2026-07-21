#!/usr/bin/env bash
# End-to-end verification for the deploy-demo-teardown plank. Runs in two
# modes, decided by whether the demo root has state:
#   DEPLOYED  → verify every exhibit live over the public API (wake from
#               0 ACU, joins/views, FK + CHECK violations, atomic rollback,
#               least-privilege denials, EXPLAIN plans, migrations) + config
#   TORN DOWN → verify the always-on half AND prove the idle state: no
#               rdb- cluster, no discovery parameters, API answers 503
set -uo pipefail
cd "$(dirname "$0")/.."

TF="terraform -chdir=infra"
TFD="terraform -chdir=demo"
SITE=$($TF output -raw site_url)

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
check(){ if [ "$1" = "0" ]; then ok "$2"; else bad "$2"; fi }

# POST an exhibit, riding out 202s while Aurora resumes from 0 ACU.
run_exhibit() {
  local id="$1" tries=0
  while [ $tries -lt 40 ]; do
    local out code
    out=$(curl -sS -w '\n%{http_code}' -X POST "$SITE/api/run/$id")
    code=$(echo "$out" | tail -1)
    if [ "$code" = "202" ]; then tries=$((tries+1)); sleep 3; continue; fi
    echo "$out" | sed '$d'
    return 0
  done
  echo '{"message":"timed out waiting for resume"}'
}

echo "verifying $SITE"

# ---- 1. always-on: static site + security headers ----
HDRS=$(curl -sS -D - -o /tmp/rdb-index.html "$SITE/" | tr -d '\r')
grep -q "Alpenglow Land &amp; Records Registry" /tmp/rdb-index.html; check $? "site serves the Registry page"
echo "$HDRS" | grep -qi "strict-transport-security" || [ $? -eq 141 ]; check $? "HSTS header present"
echo "$HDRS" | grep -qi "content-security-policy" || [ $? -eq 141 ]; check $? "CSP header present"

# ---- 2. always-on: exhibit catalog + persisted evidence ----
CAT=$(curl -sS "$SITE/api/exhibits")
N_EX=$(echo "$CAT" | jq '.exhibits | length')
[ "$N_EX" -ge 10 ]; check $? "exhibit catalog served ($N_EX exhibits)"

STATUS=$(curl -sS "$SITE/evidence/status.json")
echo "$STATUS" | jq -e 'has("deployed")' > /dev/null; check $? "status.json served (deployed=$(echo "$STATUS" | jq -r '.deployed'))"
EV=$(curl -sS "$SITE/evidence/evidence.json")
echo "$EV" | jq -e '.generatedAt and .cluster and .integrity and .migrations and .plans' > /dev/null
check $? "evidence.json has every exhibit section"
curl -sS "$SITE/evidence/evidence.html" | grep -q "Registry Database Evidence Report" || [ $? -eq 141 ]
check $? "standalone evidence.html served through CloudFront"

echo "$EV" | jq -e '.cluster.scalesToZero and .cluster.dataApiEnabled and .cluster.storageEncrypted' > /dev/null
check $? "evidence: cluster scaled to zero, Data API only, encrypted"
echo "$EV" | jq -e '.integrity.fkViolation.ok and .integrity.checkViolation.ok and .integrity.txnRollback.ok and .integrity.leastPrivilege.ok' > /dev/null
check $? "evidence: all four integrity proofs held"
echo "$EV" | jq -e '.plans.indexed.usesIndexScan and .plans.seqScan.usesSeqScan' > /dev/null
check $? "evidence: planner shows Index Scan vs Seq Scan"
echo "$EV" | jq -e '(.migrations | length) >= 4' > /dev/null
check $? "evidence: migration ledger recorded ($(echo "$EV" | jq '.migrations | length') migrations)"
echo "$EV" | jq -e '(.data.counts.permits | tonumber) > 5000' > /dev/null
check $? "evidence: seeded system of record ($(echo "$EV" | jq -r '.data.counts.permits') permits)"

# ---- 3. mode split ----
# (wc consumes all input — `grep -q` here would SIGPIPE terraform under pipefail)
DEMO_RESOURCES=$($TFD state list 2>/dev/null | wc -l | tr -d ' ')
if [ "$DEMO_RESOURCES" -gt 0 ]; then
  echo "— demo stack DEPLOYED: verifying live exhibits —"

  API_STATUS=$(curl -sS "$SITE/api/status")
  echo "$API_STATUS" | jq -e '.deployed == true' > /dev/null; check $? "/api/status reports deployed"
  echo "$API_STATUS" | jq -e '.cluster.minAcu == 0' > /dev/null; check $? "min capacity is 0 ACU (scale-to-zero configured)"
  echo "$API_STATUS" | jq -e '.cluster.autoPauseSeconds == 300' > /dev/null; check $? "auto-pause after 300s idle"

  CLUSTER_ID=$($TFD output -raw cluster_id)
  aws rds describe-db-clusters --db-cluster-identifier "$CLUSTER_ID" \
    --query 'DBClusters[0].Status' --output text | grep -q available || [ $? -eq 141 ]
  check $? "cluster $CLUSTER_ID is available"
  [ "$(aws rds describe-db-clusters --db-cluster-identifier "$CLUSTER_ID" --query 'DBClusters[0].HttpEndpointEnabled' --output text)" = "True" ]
  check $? "RDS Data API (HTTP endpoint) enabled"

  # the security group really has zero rules
  SG=$(aws rds describe-db-clusters --db-cluster-identifier "$CLUSTER_ID" --query 'DBClusters[0].VpcSecurityGroups[0].VpcSecurityGroupId' --output text)
  RULES=$(aws ec2 describe-security-group-rules --filters "Name=group-id,Values=$SG" --query 'length(SecurityGroupRules)' --output json)
  [ "$RULES" = "0" ]; check $? "cluster security group has zero rules (Data API only)"

  WAKE=$(run_exhibit wake)
  echo "$WAKE" | jq -e '.kind == "rows" and (.rows | length) == 1' > /dev/null; check $? "wake exhibit returns server time (cluster answers)"
  echo "$WAKE" | jq -e '.rows[0].connected_as == "app_user"' > /dev/null; check $? "public API connects as app_user (least privilege)"

  JOIN=$(run_exhibit join-activity)
  echo "$JOIN" | jq -e '.kind == "rows" and (.rows | length) >= 5' > /dev/null; check $? "three-table join returns aggregated parcels"

  VIEWT=$(run_exhibit view-throughput)
  echo "$VIEWT" | jq -e '(.rows | length) > 5' > /dev/null; check $? "permit_throughput view returns monthly rollup"

  FK=$(run_exhibit fk-violation)
  echo "$FK" | jq -e '.ok == true and (.error | test("foreign key"))' > /dev/null; check $? "FK violation rejected by the engine"

  CK=$(run_exhibit check-violation)
  echo "$CK" | jq -e '.ok == true and (.error | test("check constraint"))' > /dev/null; check $? "CHECK violation rejected by the engine"

  TXN=$(run_exhibit txn-rollback)
  echo "$TXN" | jq -e '.ok == true and .unchanged == true' > /dev/null; check $? "atomic transfer rolled back, balances unchanged"

  LP=$(run_exhibit least-privilege)
  echo "$LP" | jq -e '.ok == true' > /dev/null; check $? "app_user DELETE + DROP both denied in the engine"

  PLANS=$(run_exhibit explain-plans)
  echo "$PLANS" | jq -e '.plans[0].plan | test("Index Scan")' > /dev/null; check $? "EXPLAIN: unique lookup uses an Index Scan"
  echo "$PLANS" | jq -e '.plans[1].plan | test("Seq Scan")' > /dev/null; check $? "EXPLAIN: unindexed lookup shows a Seq Scan"

  MIG=$(run_exhibit migrations)
  echo "$MIG" | jq -e '(.rows | length) >= 4' > /dev/null; check $? "migration ledger has all migrations"

  BADEX=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/api/run/drop-everything")
  [ "$BADEX" = "404" ]; check $? "unknown exhibit id rejected (404) — no user SQL surface"

  echo "$STATUS" | jq -e '.deployed == true' > /dev/null; check $? "status.json says deployed"
else
  echo "— demo stack TORN DOWN: proving the idle state —"

  N_CLUSTERS=$(aws rds describe-db-clusters --query 'length(DBClusters[?starts_with(DBClusterIdentifier, `rdb-`)])' --output json)
  [ "$N_CLUSTERS" = "0" ]; check $? "no rdb- Aurora cluster exists (nothing billing)"

  aws ssm get-parameter --name /boardwalk/relational-registry/cluster-arn > /dev/null 2>&1 \
    && bad "discovery parameter still present" || ok "discovery parameters removed"

  API_STATUS=$(curl -sS "$SITE/api/status")
  echo "$API_STATUS" | jq -e '.deployed == false' > /dev/null; check $? "/api/status reports torn down"

  RUN_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/api/run/wake")
  [ "$RUN_CODE" = "503" ]; check $? "exhibit runs answer 503 while torn down"

  echo "$STATUS" | jq -e '.deployed == false' > /dev/null; check $? "status.json says torn down"
fi

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" = "0" ]
