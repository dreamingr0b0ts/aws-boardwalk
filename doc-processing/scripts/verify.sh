#!/usr/bin/env bash
# End-to-end verification against the LIVE deployment. The plank isn't done
# until every check here passes — including the cost-guardrail checks
# (anonymous 401, self-signup disabled, size/page caps, daily cap 429) and a
# real document pushed through the whole pipeline.
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
HDRS=$(curl -sS -D - -o /tmp/idp-index.html "$SITE/" | tr -d '\r')
grep -q "Alpenglow Document Intelligence" /tmp/idp-index.html; check $? "site serves the document intelligence page"
echo "$HDRS" | grep -qi "strict-transport-security" || [ $? -eq 141 ]; check $? "HSTS header present"
echo "$HDRS" | grep -qi "content-security-policy" || [ $? -eq 141 ]; check $? "CSP header present"
echo "$HDRS" | grep -qi "x-robots-tag: noindex" || [ $? -eq 141 ]; check $? "X-Robots-Tag: noindex (search engines told to stay out)"
curl -sS "$SITE/robots.txt" | grep -q "Disallow: /" || [ $? -eq 141 ]; check $? "robots.txt disallows crawling"

# ---- 2. the seeded index (public, free) ----
# Seeds may still be mid-pipeline right after `make seed`; give them time.
for i in $(seq 1 40); do
  LIST=$(curl -sS "$SITE/api/public/documents")
  INDEXED=$(echo "$LIST" | jq '[.documents[] | select(.status=="INDEXED" and .source=="seed")] | length')
  [ "$INDEXED" -ge 8 ] && break
  sleep 6
done
[ "$INDEXED" -ge 8 ]; check $? "seed corpus fully indexed ($INDEXED/8 documents)"
TYPES=$(echo "$LIST" | jq '[.documents[] | select(.status=="INDEXED") | .docType] | unique | length')
[ "$TYPES" -ge 4 ]; check $? "classifier produced $TYPES distinct document types (≥4)"
[ "$(echo "$LIST" | jq '.stats.entities > 20')" = "true" ]; check $? "entity extraction populated the index ($(echo "$LIST" | jq '.stats.entities') entities)"

# ---- 3. seed detail: every pipeline stage left evidence ----
INV_ID=$(echo "$LIST" | jq -r '[.documents[] | select(.docId | startswith("seed-contractor-invoice"))][0].docId')
DETAIL=$(curl -sS "$SITE/api/public/documents/$INV_ID")
echo "$DETAIL" | jq -e '.kvPairs[] | select(.value | test("1,842.50"))' > /dev/null; check $? "Textract FORMS extracted the invoice total (\$1,842.50)"
[ "$(echo "$DETAIL" | jq '.entities | length > 3')" = "true" ]; check $? "Comprehend entities present on the invoice"
[ "$(echo "$DETAIL" | jq -r '.docType')" = "invoice" ]; check $? "Bedrock classified it as an invoice"
[ "$(echo "$DETAIL" | jq -r '.summary | length > 20')" = "true" ]; check $? "AI summary present"
[ "$(echo "$DETAIL" | jq '[.steps[].name] | contains(["received","ocr-complete","entities-complete","classified","indexed"])')" = "true" ]; check $? "step timeline records every pipeline stage"
ORIG=$(echo "$DETAIL" | jq -r '.originalUrl')
ORIG_CODE=$(curl -sS -o /dev/null -w '%{http_code}' "$ORIG")
[ "$ORIG_CODE" = "200" ]; check $? "presigned link serves the original PDF"

# ---- 4. the token gate ----
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/api/uploads" \
  -H 'content-type: application/json' -d '{"filename":"x.pdf","contentType":"application/pdf","sizeBytes":100}')
[ "$CODE" = "401" ]; check $? "anonymous upload is rejected (401) — no free OCR"

SIGNUP_ERR=$(aws cognito-idp sign-up --client-id "$CLIENT" \
  --username "stranger-$RANDOM@example.com" --password 'Str4nger-Pass!xyz' 2>&1)
echo "$SIGNUP_ERR" | grep -q "NotAuthorizedException" || [ $? -eq 141 ]; check $? "public self-signup is disabled (admin-created users only)"

# ---- 5. authenticated upload → full pipeline round trip ----
AUTH=$(aws cognito-idp admin-initiate-auth --user-pool-id "$POOL" --client-id "$CLIENT" \
  --auth-flow ADMIN_USER_PASSWORD_AUTH \
  --auth-parameters USERNAME="$EMAIL",PASSWORD="$PASSWORD" --output json)
TOKEN=$(echo "$AUTH" | jq -r '.AuthenticationResult.IdToken')
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ]; check $? "demo user authenticates"
SUB=$(echo "$TOKEN" | cut -d. -f2 | python3 -c "import sys,base64,json;p=sys.stdin.read().strip();p+='='*(-len(p)%4);print(json.loads(base64.urlsafe_b64decode(p))['sub'])")

TESTPDF=corpus/pdfs/code-violation-notice.pdf
[ -f "$TESTPDF" ] || { echo "run 'make seed' first (corpus PDFs missing)"; exit 1; }
GRANT=$(curl -sS -X POST "$SITE/api/uploads" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"filename\":\"verify-upload.pdf\",\"contentType\":\"application/pdf\",\"sizeBytes\":$(stat -f%z "$TESTPDF")}")
DOCID=$(echo "$GRANT" | jq -r '.docId')
[ -n "$DOCID" ] && [ "$DOCID" != "null" ]; check $? "upload grant issued (docId $DOCID)"

S3_FORM=$(echo "$GRANT" | jq -r '.upload.fields | to_entries | map("-F \(.key)=\(.value|@sh)") | join(" ")')
S3_CODE=$(eval curl -sS -o /dev/null -w "'%{http_code}'" "$S3_FORM" -F "file=@$TESTPDF" "$(echo "$GRANT" | jq -r '.upload.url')")
[ "$S3_CODE" = "204" ]; check $? "presigned POST accepted by S3"

UP_STATUS=""
for i in $(seq 1 50); do
  UP=$(curl -sS "$SITE/api/public/documents/$DOCID")
  UP_STATUS=$(echo "$UP" | jq -r '.status // empty')
  [ "$UP_STATUS" = "INDEXED" ] || [ "$UP_STATUS" = "FAILED" ] || [ "$UP_STATUS" = "REJECTED" ] && break
  sleep 5
done
[ "$UP_STATUS" = "INDEXED" ]; check $? "uploaded document went through the full pipeline (status: $UP_STATUS)"
[ "$(echo "$UP" | jq -r '.docType')" != "null" ]; check $? "uploaded document was classified ($(echo "$UP" | jq -r '.docType'))"

# ---- 6. the caps actually bite ----
BIG=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/api/uploads" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"filename":"big.pdf","contentType":"application/pdf","sizeBytes":10485760}')
[ "$BIG" = "400" ]; check $? "oversize upload request rejected (400)"

EXE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/api/uploads" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"filename":"evil.exe","contentType":"application/x-msdownload","sizeBytes":100}')
[ "$EXE" = "400" ]; check $? "unsupported file type rejected (400)"

# page cap: upload the 7-page fixture, expect the pipeline to REJECT before OCR
OVER=corpus/pdfs/_over-page-limit.pdf
GRANT2=$(curl -sS -X POST "$SITE/api/uploads" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"filename\":\"over-page-limit.pdf\",\"contentType\":\"application/pdf\",\"sizeBytes\":$(stat -f%z "$OVER")}")
DOCID2=$(echo "$GRANT2" | jq -r '.docId')
S3_FORM2=$(echo "$GRANT2" | jq -r '.upload.fields | to_entries | map("-F \(.key)=\(.value|@sh)") | join(" ")')
eval curl -sS -o /dev/null "$S3_FORM2" -F "file=@$OVER" "$(echo "$GRANT2" | jq -r '.upload.url')"
REJ_STATUS=""
for i in $(seq 1 20); do
  REJ_STATUS=$(curl -sS "$SITE/api/public/documents/$DOCID2" | jq -r '.status // empty')
  [ "$REJ_STATUS" = "REJECTED" ] && break
  sleep 3
done
[ "$REJ_STATUS" = "REJECTED" ]; check $? "7-page document REJECTED before any OCR spend"

# daily cap: force today's per-user counter to the limit, expect 429, reset it
TODAY=$(date -u +%F)
LIMIT=$(curl -sS "$SITE/api/me/quota" -H "authorization: Bearer $TOKEN" | jq -r '.userLimit')
aws dynamodb put-item --table-name "$TABLE" --no-cli-pager \
  --item "{\"PK\":{\"S\":\"USAGE#$TODAY\"},\"SK\":{\"S\":\"USER#$SUB\"},\"count\":{\"N\":\"$LIMIT\"}}" > /dev/null
CAP_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/api/uploads" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"filename":"one-more.pdf","contentType":"application/pdf","sizeBytes":100}')
[ "$CAP_CODE" = "429" ]; check $? "per-user daily cap returns 429 at the limit"
aws dynamodb delete-item --table-name "$TABLE" --no-cli-pager \
  --key "{\"PK\":{\"S\":\"USAGE#$TODAY\"},\"SK\":{\"S\":\"USER#$SUB\"}}" > /dev/null

# ---- 7. nightly reset purges uploads, keeps seeds ----
OUT=$(mktemp)
aws lambda invoke --function-name "$($TF output -raw reset_function)" \
  --cli-binary-format raw-in-base64-out --payload '{}' --no-cli-pager "$OUT" > /dev/null
PURGED=$(jq -r '.purged' "$OUT"); rm -f "$OUT"
[ "$PURGED" -ge 1 ]; check $? "reset purged the verification uploads ($PURGED)"
AFTER=$(curl -sS "$SITE/api/public/documents")
[ "$(echo "$AFTER" | jq "[.documents[] | select(.docId==\"$DOCID\")] | length")" = "0" ]; check $? "uploaded document is gone from the index"
[ "$(echo "$AFTER" | jq '[.documents[] | select(.source=="seed" and .status=="INDEXED")] | length')" -ge 8 ]; check $? "seed corpus survived the reset"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" = "0" ]
