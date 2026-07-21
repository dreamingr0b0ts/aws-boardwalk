#!/usr/bin/env bash
# End-to-end verification against the LIVE deployment. The plank isn't done
# until every check here passes — including the abuse-guardrail checks
# (anonymous 401, self-signup disabled, daily cap returns 429).
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
HDRS=$(curl -sS -D - -o /tmp/gai-index.html "$SITE/" | tr -d '\r')
grep -q "Alpenglow Records Assistant" /tmp/gai-index.html; check $? "site serves the assistant page"
echo "$HDRS" | grep -qi "strict-transport-security" || [ $? -eq 141 ]; check $? "HSTS header present"
echo "$HDRS" | grep -qi "content-security-policy" || [ $? -eq 141 ]; check $? "CSP header present"
echo "$HDRS" | grep -qi "x-robots-tag: noindex" || [ $? -eq 141 ]; check $? "X-Robots-Tag: noindex (search engines told to stay out)"
curl -sS "$SITE/robots.txt" | grep -q "Disallow: /" || [ $? -eq 141 ]; check $? "robots.txt disallows crawling"

# ---- 2. public metadata route (no auth, no AI) ----
INFO=$(curl -sS "$SITE/api/public/info")
[ "$(echo "$INFO" | jq -r '.corpus.chunks > 0')" = "true" ]; check $? "public info reports an indexed corpus ($(echo "$INFO" | jq -r '.corpus.chunks') chunks)"

# ---- 3. the token gate ----
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/api/chat" \
  -H 'content-type: application/json' -d '{"question":"hi"}')
[ "$CODE" = "401" ]; check $? "anonymous /api/chat is rejected (401) — no free AI queries"

SIGNUP_ERR=$(aws cognito-idp sign-up --client-id "$CLIENT" \
  --username "stranger-$RANDOM@example.com" --password 'Str4nger-Pass!xyz' 2>&1)
echo "$SIGNUP_ERR" | grep -q "NotAuthorizedException" || [ $? -eq 141 ]; check $? "public self-signup is disabled (admin-created users only)"

# ---- 4. authenticated round trip ----
AUTH=$(aws cognito-idp admin-initiate-auth --user-pool-id "$POOL" --client-id "$CLIENT" \
  --auth-flow ADMIN_USER_PASSWORD_AUTH \
  --auth-parameters USERNAME="$EMAIL",PASSWORD="$PASSWORD" --output json)
TOKEN=$(echo "$AUTH" | jq -r '.AuthenticationResult.IdToken')
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ]; check $? "demo user authenticates"
SUB=$(echo "$TOKEN" | cut -d. -f2 | python3 -c "import sys,base64,json;p=sys.stdin.read().strip();p+='='*(-len(p)%4);print(json.loads(base64.urlsafe_b64decode(p))['sub'])")

CHAT=$(curl -sS -X POST "$SITE/api/chat" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"question":"How much does a residential deck permit cost?"}')
echo "$CHAT" | jq -e '.answer | test("145")' > /dev/null; check $? "grounded answer contains the corpus fact (\$145 deck permit)"
[ "$(echo "$CHAT" | jq -r '.citations | length > 0')" = "true" ]; check $? "answer carries citations"
[ "$(echo "$CHAT" | jq -r '.confidence')" != "null" ]; check $? "confidence score returned"

OFFTOPIC=$(curl -sS -X POST "$SITE/api/chat" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"question":"What is the capital of France?"}')
echo "$OFFTOPIC" | jq -e '.answer | test("Paris") | not' > /dev/null; check $? "off-corpus question is declined (guardrail holds, no 'Paris')"

QUOTA=$(curl -sS "$SITE/api/me/quota" -H "authorization: Bearer $TOKEN")
[ "$(echo "$QUOTA" | jq -r '.userUsed >= 2')" = "true" ]; check $? "quota endpoint tracks usage ($(echo "$QUOTA" | jq -r '.userUsed') used)"

MSGID=$(echo "$CHAT" | jq -r '.messageId')
FB=$(curl -sS -X POST "$SITE/api/feedback" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"messageId\":\"$MSGID\",\"rating\":\"up\"}")
[ "$(echo "$FB" | jq -r '.ok')" = "true" ]; check $? "feedback loop records a rating"

# ---- 5. the daily cap actually bites ----
# Force today's per-user counter to the limit, expect 429, then reset it.
TODAY=$(date -u +%F)
LIMIT=$(echo "$QUOTA" | jq -r '.userLimit')
aws dynamodb put-item --table-name "$TABLE" --no-cli-pager \
  --item "{\"PK\":{\"S\":\"USAGE#$TODAY\"},\"SK\":{\"S\":\"USER#$SUB\"},\"count\":{\"N\":\"$LIMIT\"}}" > /dev/null
CAP_CODE=$(curl -sS -o /tmp/gai-cap.json -w '%{http_code}' -X POST "$SITE/api/chat" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"question":"one more?"}')
[ "$CAP_CODE" = "429" ]; check $? "per-user daily cap returns 429 at the limit"
aws dynamodb delete-item --table-name "$TABLE" --no-cli-pager \
  --key "{\"PK\":{\"S\":\"USAGE#$TODAY\"},\"SK\":{\"S\":\"USER#$SUB\"}}" > /dev/null

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" = "0" ]
