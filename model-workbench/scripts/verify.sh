#!/usr/bin/env bash
# End-to-end verification against the LIVE deployment. The plank isn't done
# until every check here passes — including the abuse-guardrail checks
# (anonymous 401, self-signup disabled, validation 400s, daily cap 429).
# The comparison run uses the two cheapest models; a full verify costs well
# under a cent.
set -uo pipefail
cd "$(dirname "$0")/.."

TF="terraform -chdir=infra"
SITE=$($TF output -raw site_url)
POOL=$($TF output -raw user_pool_id)
CLIENT=$($TF output -raw user_pool_client_id)
TABLE=$($TF output -raw table_name)
EMAIL=$($TF output -raw demo_email)
PASSWORD=$(cat .demo-creds)

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
check(){ if [ "$1" = "0" ]; then ok "$2"; else bad "$2"; fi }

echo "verifying $SITE"

# ---- 1. static site + security headers ----
HDRS=$(curl -sS -D - -o /tmp/fmw-index.html "$SITE/" | tr -d '\r')
grep -q "Alpenglow Model Workbench" /tmp/fmw-index.html; check $? "site serves the workbench page"
echo "$HDRS" | grep -qi "strict-transport-security" || [ $? -eq 141 ]; check $? "HSTS header present"
echo "$HDRS" | grep -qi "content-security-policy" || [ $? -eq 141 ]; check $? "CSP header present"
echo "$HDRS" | grep -qi "x-robots-tag: noindex" || [ $? -eq 141 ]; check $? "X-Robots-Tag: noindex (search engines told to stay out)"
curl -sS "$SITE/robots.txt" | grep -q "Disallow: /" || [ $? -eq 141 ]; check $? "robots.txt disallows crawling"

# ---- 2. public metadata route (no auth, no AI) ----
INFO=$(curl -sS "$SITE/api/public/info")
[ "$(echo "$INFO" | jq '.models | length')" = "4" ]; check $? "public info lists the 4-model roster"
echo "$INFO" | jq -e '[.models[].vendor] | sort == ["Amazon","Anthropic","Meta","Mistral"]' > /dev/null
check $? "roster spans four vendors"
[ "$(echo "$INFO" | jq '.scenarios | length')" -ge 5 ]; check $? "scenario library served ($(echo "$INFO" | jq '.scenarios | length') scenarios)"

# ---- 3. the token gate ----
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/api/run" \
  -H 'content-type: application/json' -d '{"prompt":"hi"}')
[ "$CODE" = "401" ]; check $? "anonymous /api/run is rejected (401) — no free model invocations"

SIGNUP_ERR=$(aws cognito-idp sign-up --client-id "$CLIENT" \
  --username "stranger-$RANDOM@example.com" --password 'Str4nger-Pass!xyz' 2>&1)
echo "$SIGNUP_ERR" | grep -q "NotAuthorizedException" || [ $? -eq 141 ]; check $? "public self-signup is disabled (admin-created users only)"

# ---- 4. authenticated comparison round trip ----
AUTH=$(aws cognito-idp admin-initiate-auth --user-pool-id "$POOL" --client-id "$CLIENT" \
  --auth-flow ADMIN_USER_PASSWORD_AUTH \
  --auth-parameters USERNAME="$EMAIL",PASSWORD="$PASSWORD" --output json)
TOKEN=$(echo "$AUTH" | jq -r '.AuthenticationResult.IdToken')
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ]; check $? "demo user authenticates"
SUB=$(echo "$TOKEN" | cut -d. -f2 | python3 -c "import sys,base64,json;p=sys.stdin.read().strip();p+='='*(-len(p)%4);print(json.loads(base64.urlsafe_b64decode(p))['sub'])")

RUN=$(curl -sS -X POST "$SITE/api/run" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"scenarioId":"extract-json","models":["nova-lite","llama"],"temperature":0,"maxTokens":300}')
[ "$(echo "$RUN" | jq '.results | length')" = "2" ]; check $? "comparison run returns both models"
echo "$RUN" | jq -e '.results | all(.ok and (.text | length > 0))' > /dev/null; check $? "every model answered with text"
echo "$RUN" | jq -e '.results | all(.usage.inputTokens > 0 and .usage.outputTokens > 0)' > /dev/null
check $? "token usage reported per model"
echo "$RUN" | jq -e '(.results | all(.costUsd > 0)) and (.totalCostUsd > 0)' > /dev/null
check $? "cost computed per model (run total \$$(echo "$RUN" | jq -r '.totalCostUsd'))"
echo "$RUN" | jq -e '.results | all(.latencyMs > 0)' > /dev/null; check $? "latency measured per model"
echo "$RUN" | jq -e '.results[0].text | test("applicant"; "i")' > /dev/null
check $? "extraction scenario yields JSON-shaped output"

# custom prompt across the same two cheap models
RUN2=$(curl -sS -X POST "$SITE/api/run" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"prompt":"Reply with exactly the word OK and nothing else.","models":["nova-lite","llama"],"maxTokens":50}')
echo "$RUN2" | jq -e '.results | all(.ok)' > /dev/null; check $? "custom prompt runs on the roster"

# ---- 5. validation fences ----
BADMODEL=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/api/run" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"prompt":"hi","models":["gpt-4"]}')
[ "$BADMODEL" = "400" ]; check $? "off-roster model rejected (400) — IAM fence never even tested"
BADTOK=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/api/run" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"prompt":"hi","maxTokens":5000}')
[ "$BADTOK" = "400" ]; check $? "over-ceiling maxTokens rejected (400)"

# ---- 6. quota + audit ledger ----
QUOTA=$(curl -sS "$SITE/api/me/quota" -H "authorization: Bearer $TOKEN")
[ "$(echo "$QUOTA" | jq -r '.userUsed >= 2')" = "true" ]; check $? "quota endpoint tracks usage ($(echo "$QUOTA" | jq -r '.userUsed') used)"

RUNS=$(curl -sS "$SITE/api/runs" -H "authorization: Bearer $TOKEN")
[ "$(echo "$RUNS" | jq '.runs | length')" -ge 2 ]; check $? "audit ledger lists today's runs"
echo "$RUNS" | jq -e '.runs[0].results | all(has("costUsd") and has("latencyMs"))' > /dev/null
check $? "ledger rows carry tokens, cost, and latency per model"

# ---- 7. the daily cap actually bites ----
TODAY=$(date -u +%F)
LIMIT=$(echo "$QUOTA" | jq -r '.userLimit')
aws dynamodb put-item --table-name "$TABLE" --no-cli-pager \
  --item "{\"PK\":{\"S\":\"USAGE#$TODAY\"},\"SK\":{\"S\":\"USER#$SUB\"},\"count\":{\"N\":\"$LIMIT\"}}" > /dev/null
CAP_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/api/run" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"prompt":"one more?","models":["nova-lite"]}')
[ "$CAP_CODE" = "429" ]; check $? "per-user daily cap returns 429 at the limit"
aws dynamodb delete-item --table-name "$TABLE" --no-cli-pager \
  --key "{\"PK\":{\"S\":\"USAGE#$TODAY\"},\"SK\":{\"S\":\"USER#$SUB\"}}" > /dev/null

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" = "0" ]
