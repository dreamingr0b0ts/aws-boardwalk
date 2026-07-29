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
[ "$(echo "$INFO" | jq -r '.corpus.docList | length > 0')" = "true" ]; check $? "index metadata carries the reading-room docList"

# ---- 2b. reading room (no auth, no AI) ----
DOC=$(curl -sS "$SITE/api/public/doc?name=building-permits.md")
echo "$DOC" | jq -e '.markdown | test("145")' > /dev/null; check $? "reading room serves corpus markdown (deck fee present)"
TRAV=$(curl -sS -o /dev/null -w '%{http_code}' "$SITE/api/public/doc?name=../index/meta.json")
[ "$TRAV" = "400" ]; check $? "reading room rejects path traversal (400)"
NODOC=$(curl -sS -o /dev/null -w '%{http_code}' "$SITE/api/public/doc?name=not-a-doc.md")
[ "$NODOC" = "404" ]; check $? "reading room 404s on unindexed documents"

# ---- 2c. visitor tier: curated questions only, tightly capped ----
# NOTE: the two live checks below consume 2 of this IP's 5 daily free
# questions (one real answer + one burned by the pool-cap probe).
QS=$(curl -sS "$SITE/api/public/questions")
[ "$(echo "$QS" | jq -r '.questions | length >= 10')" = "true" ]; check $? "question library serves the curated list ($(echo "$QS" | jq -r '.questions | length') questions)"
[ "$(echo "$QS" | jq -r '[.questions[] | select(.offCorpus)] | length >= 1')" = "true" ]; check $? "library includes the refusal exhibit (off-corpus question)"

TYPED=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/api/public/chat" \
  -H 'content-type: application/json' -d '{"question":"free-typed text"}')
[ "$TYPED" = "403" ]; check $? "visitor-typed text never reaches a model (403)"
BOGUS=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/api/public/chat" \
  -H 'content-type: application/json' -d '{"questionId":"not-in-library"}')
[ "$BOGUS" = "400" ]; check $? "unknown question id is rejected (400)"

VCHAT=$(curl -sS -X POST "$SITE/api/public/chat" \
  -H 'content-type: application/json' -d '{"questionId":"deck-cost"}')
echo "$VCHAT" | jq -e '.answer | test("145")' > /dev/null; check $? "visitor answer is grounded (deck fee cited without sign-in)"
[ "$(echo "$VCHAT" | jq -r '.tier')" = "visitor" ]; check $? "visitor answers are tier-tagged"
[ "$(echo "$VCHAT" | jq -r '.passages | length')" = "4" ]; check $? "retrieval under glass: all 4 retrieved passages returned"
[ "$(echo "$VCHAT" | jq -r '[.passages[] | select(.cited)] | length >= 1')" = "true" ]; check $? "passages carry cited/not-used flags"
[ "$(echo "$VCHAT" | jq -r '.cost.usd > 0')" = "true" ]; check $? "cost per answer computed (\$$(echo "$VCHAT" | jq -r '.cost.usd'))"

VQUOTA=$(curl -sS "$SITE/api/public/quota")
[ "$(echo "$VQUOTA" | jq -r '.tier')" = "visitor" ] && [ "$(echo "$VQUOTA" | jq -r '.userUsed >= 1')" = "true" ]; check $? "visitor quota tracks this IP ($(echo "$VQUOTA" | jq -r '.userUsed')/$(echo "$VQUOTA" | jq -r '.userLimit') used)"

# The anonymous pool is its own kill switch: force it to the limit, expect
# 429 on the next free question, then reset it.
TODAY=$(date -u +%F)
POOL_LIMIT=$(echo "$INFO" | jq -r '.limits.visitorPoolDaily')
aws dynamodb put-item --table-name "$TABLE" --no-cli-pager \
  --item "{\"PK\":{\"S\":\"USAGE#$TODAY\"},\"SK\":{\"S\":\"ANON-GLOBAL\"},\"count\":{\"N\":\"$POOL_LIMIT\"}}" > /dev/null
POOL_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/api/public/chat" \
  -H 'content-type: application/json' -d '{"questionId":"deck-cost"}')
[ "$POOL_CODE" = "429" ]; check $? "anonymous pool cap returns 429 at the limit"
aws dynamodb delete-item --table-name "$TABLE" --no-cli-pager \
  --key "{\"PK\":{\"S\":\"USAGE#$TODAY\"},\"SK\":{\"S\":\"ANON-GLOBAL\"}}" > /dev/null

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
[ "$(echo "$CHAT" | jq -r '.passages | length')" = "4" ]; check $? "signed-in answers carry the retrieval trace too"
[ "$(echo "$CHAT" | jq -r '.cost.usd > 0')" = "true" ]; check $? "signed-in answers carry cost per answer"

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
