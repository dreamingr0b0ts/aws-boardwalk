#!/usr/bin/env bash
# End-to-end verification against the LIVE deployment. The plank isn't done
# until every check here passes — including the governance failure paths:
# missing keys must 403 at the gateway, schema-invalid bodies must 400 before
# any Lambda runs, and a burst must draw real usage-plan 429s.
set -uo pipefail
cd "$(dirname "$0")/.."

TF="terraform -chdir=infra"
SITE=$($TF output -raw site_url)
DEMO_KEY=$($TF output -raw demo_api_key)
PARTNER_KEY=$($TF output -raw partner_api_key)

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
check(){ if [ "$1" = "0" ]; then ok "$2"; else bad "$2"; fi }

# Functional checks ride the partner tier (25 rps) so the suite never races
# the demo tier's deliberately tight 5 rps throttle; the demo key appears only
# in the checks that are ABOUT the demo tier.
get()  { curl -sS -H "x-api-key: $PARTNER_KEY" "$SITE$1"; }
code() { curl -sS -o /dev/null -w '%{http_code}' -H "x-api-key: $PARTNER_KEY" "$@"; }

echo "verifying $SITE"

# ---- 1. docs site + security headers ----
HDRS=$(curl -sS -D - -o /tmp/apx-index.html "$SITE/" | tr -d '\r')
grep -q "Alpenglow Developer API" /tmp/apx-index.html; check $? "site serves the API docs page"
echo "$HDRS" | grep -qi "strict-transport-security" || [ $? -eq 141 ]; check $? "HSTS header present"
echo "$HDRS" | grep -qi "content-security-policy" || [ $? -eq 141 ]; check $? "CSP header present"

SPEC=$(curl -sS "$SITE/openapi.json")
echo "$SPEC" | jq -e '.openapi and (.paths | has("/v2/permits"))' > /dev/null
check $? "published /openapi.json is valid and lists /v2/permits"
echo "$SPEC" | jq -e '[.. | objects | keys[]] | map(select(startswith("x-amazon"))) | length == 0' > /dev/null
check $? "published spec has the x-amazon-* deployment wiring stripped"
curl -sS "$SITE/config.json" | jq -e '.demoKey | length > 10' > /dev/null
check $? "config.json carries the demo key"

# ---- 2. keyless platform endpoints ----
STATUS=$(curl -sS "$SITE/v2/status")
echo "$STATUS" | jq -e '.status == "operational"' > /dev/null; check $? "/v2/status keyless and operational"
echo "$STATUS" | jq -e '[.services[].name] | sort == ["exports","facilities","licenses","permits"]' > /dev/null
check $? "status reports all four microservices (catalogs + exports)"
curl -sS "$SITE/v1/ping" | jq -e '.integration == "mock"' > /dev/null
check $? "/v1/ping answered by the API Gateway mock integration"

# ---- 3. API keys + usage plans ----
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "$SITE/v2/permits")
[ "$CODE" = "403" ]; check $? "request without x-api-key is rejected at the gateway (403)"
BODY=$(curl -sS "$SITE/v2/permits")
echo "$BODY" | jq -e '.error == "forbidden"' > /dev/null; check $? "keyless rejection uses the friendly gateway response body"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -H "x-api-key: $DEMO_KEY" "$SITE/v2/permits?limit=1")
[ "$CODE" = "200" ]; check $? "demo key admits the same request (200)"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -H "x-api-key: $PARTNER_KEY" "$SITE/v2/permits?limit=1")
[ "$CODE" = "200" ]; check $? "partner-tier key works against the identical API"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "$SITE/v2/nonexistent" -H "x-api-key: $DEMO_KEY")
[ "$CODE" = "404" ]; check $? "unknown path remapped from gateway default 403 to honest 404"

# ---- 4. v2 pagination + filtering (permits service) ----
PAGE1=$(get "/v2/permits?limit=5")
echo "$PAGE1" | jq -e '(.data | length == 5) and (.meta.count == 5) and (.meta.nextToken | length > 0)' > /dev/null
check $? "v2 permits: envelope with 5 items and a nextToken cursor"
TOKEN=$(echo "$PAGE1" | jq -r '.meta.nextToken')
PAGE2=$(get "/v2/permits?limit=5&nextToken=$TOKEN")
FIRST1=$(echo "$PAGE1" | jq -r '.data[0].id'); FIRST2=$(echo "$PAGE2" | jq -r '.data[0].id')
[ "$FIRST2" != "null" ] && [ "$FIRST1" != "$FIRST2" ]; check $? "cursor fetches a distinct second page"
get "/v2/permits?type=solar&limit=50" | jq -e '.data | length > 0 and all(.type == "solar")' > /dev/null
check $? "?type=solar filter returns only solar permits"
CODE=$(code "$SITE/v2/permits?type=volcano")
[ "$CODE" = "400" ]; check $? "invalid filter value rejected (400)"
CODE=$(code "$SITE/v2/permits?nextToken=garbage")
[ "$CODE" = "400" ]; check $? "garbage pagination cursor rejected (400)"

PERMIT_ID=$(get "/v2/permits?status=issued&limit=1" | jq -r '.data[0].id')
get "/v2/permits/$PERMIT_ID" | jq -e --arg id "$PERMIT_ID" '.data.id == $id' > /dev/null
check $? "GET /v2/permits/{id} round-trips ($PERMIT_ID)"
CODE=$(code "$SITE/v2/permits/PRM-9999-9999")
[ "$CODE" = "404" ]; check $? "unknown permit id → 404"

# ---- 5. v1 deprecation story ----
V1=$(curl -sS -D /tmp/apx-v1-headers -H "x-api-key: $PARTNER_KEY" "$SITE/v1/permits")
tr -d '\r' < /tmp/apx-v1-headers > /tmp/apx-v1-headers.clean
echo "$V1" | jq -e 'type == "array"' > /dev/null; check $? "v1 permits returns the legacy bare array"
grep -qi '^deprecation:' /tmp/apx-v1-headers.clean; check $? "v1 response carries a Deprecation header"
grep -qi '^sunset:' /tmp/apx-v1-headers.clean; check $? "v1 response carries a Sunset header"
grep -qi 'successor-version' /tmp/apx-v1-headers.clean; check $? "v1 Link header points at the v2 successor"

# ---- 6. gateway request validation (inspections write path) ----
CODE=$(curl -sS -o /tmp/apx-badbody -w '%{http_code}' -X POST "$SITE/v2/permits/$PERMIT_ID/inspections" \
  -H "x-api-key: $PARTNER_KEY" -H 'content-type: application/json' \
  -d '{"type":"quantum-vibe-check","preferredDate":"soon"}')
[ "$CODE" = "400" ]; check $? "schema-invalid inspection body rejected 400 by the gateway"
jq -e '.error == "validation_failed"' /tmp/apx-badbody > /dev/null
check $? "rejection body is the gateway validator's, not the Lambda's"

INSPECTION=$(curl -sS -X POST "$SITE/v2/permits/$PERMIT_ID/inspections" \
  -H "x-api-key: $PARTNER_KEY" -H 'content-type: application/json' \
  -d '{"type":"rough","preferredDate":"2026-08-14","contactEmail":"verify@planetek.org","notes":"verify.sh round-trip"}')
INSP_ID=$(echo "$INSPECTION" | jq -r '.data.id')
[ -n "$INSP_ID" ] && [ "$INSP_ID" != "null" ]; check $? "valid inspection request accepted (201 → $INSP_ID)"
get "/v2/permits/$PERMIT_ID/inspections" | jq -e --arg id "$INSP_ID" '.data | any(.id == $id)' > /dev/null
check $? "created inspection appears in the permit's inspection list"
DENIED_ID=$(get "/v2/permits?status=denied&limit=1" | jq -r '.data[0].id')
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/v2/permits/$DENIED_ID/inspections" \
  -H "x-api-key: $PARTNER_KEY" -H 'content-type: application/json' \
  -d '{"type":"final","preferredDate":"2026-08-14","contactEmail":"verify@planetek.org"}')
[ "$CODE" = "409" ]; check $? "denied permit refuses inspection requests (409 business rule, from the Lambda)"

# ---- 7. licenses + facilities services ----
get "/v2/licenses?category=liquor&limit=50" | jq -e '.data | length > 0 and all(.category == "liquor")' > /dev/null
check $? "licenses service filters by category"
LIC_ID=$(get "/v2/licenses?limit=1" | jq -r '.data[0].id')
get "/v2/licenses/$LIC_ID" | jq -e --arg id "$LIC_ID" '.data.id == $id' > /dev/null
check $? "GET /v2/licenses/{id} round-trips ($LIC_ID)"
get "/v2/facilities?kind=trail&limit=50" | jq -e '.data | length > 0 and all(.kind == "trail")' > /dev/null
check $? "facilities service filters by kind"
get "/v2/facilities/FAC-009/hours" | jq -e '.data.hours.mon | length > 0' > /dev/null
check $? "facility hours sub-resource serves weekly hours"

# ---- 8. usage-plan throttling (demo tier: 2 rps / burst 5) ----
# Distributed token buckets are best-effort (see variables.tf) — a single
# burst can sail through, so allow up to three rounds before calling it.
for ROUND in 1 2 3; do
  BURST=$(seq 1 40 | xargs -P 20 -I{} curl -sS -o /dev/null -w '%{http_code}\n' \
    -H "x-api-key: $DEMO_KEY" "$SITE/v2/facilities?limit=1")
  N429=$(echo "$BURST" | grep -c '^429' || true)
  N200=$(echo "$BURST" | grep -c '^200' || true)
  [ "$N429" -ge 1 ] && break
  sleep 15
done
[ "$N429" -ge 1 ] && [ "$N200" -ge 1 ]; check $? "40-request burst drew usage-plan 429s ($N200 × 200, $N429 × 429, round $ROUND)"

# ---- 9. conditional GETs (ETag / If-None-Match) ----
ETAG=$(curl -sS -D - -o /dev/null -H "x-api-key: $PARTNER_KEY" "$SITE/v2/facilities/FAC-009" | tr -d '\r' | awk 'tolower($1)=="etag:"{print $2}')
[ -n "$ETAG" ]; check $? "detail GET carries a strong ETag ($ETAG)"
CODE=$(curl -sS -o /tmp/apx-304-body -w '%{http_code}' -H "x-api-key: $PARTNER_KEY" -H "if-none-match: $ETAG" "$SITE/v2/facilities/FAC-009")
[ "$CODE" = "304" ]; check $? "If-None-Match with the same ETag answers 304"
[ ! -s /tmp/apx-304-body ]; check $? "the 304 is bodiless"

# ---- 10. idempotency keys (inspections write path) ----
IDEM="verify-$(date +%s)"
IDEM_BODY='{"type":"rough","preferredDate":"2026-08-15","contactEmail":"verify@planetek.org","notes":"idempotency round-trip"}'
FIRST=$(curl -sS -X POST "$SITE/v2/permits/$PERMIT_ID/inspections" \
  -H "x-api-key: $PARTNER_KEY" -H 'content-type: application/json' -H "idempotency-key: $IDEM" -d "$IDEM_BODY")
FIRST_ID=$(echo "$FIRST" | jq -r '.data.id')
SECOND=$(curl -sS -D /tmp/apx-idem-headers -X POST "$SITE/v2/permits/$PERMIT_ID/inspections" \
  -H "x-api-key: $PARTNER_KEY" -H 'content-type: application/json' -H "idempotency-key: $IDEM" -d "$IDEM_BODY")
SECOND_ID=$(echo "$SECOND" | jq -r '.data.id')
[ -n "$FIRST_ID" ] && [ "$FIRST_ID" = "$SECOND_ID" ]; check $? "repeated Idempotency-Key replays the same inspection ($FIRST_ID)"
tr -d '\r' < /tmp/apx-idem-headers | grep -qi '^idempotency-replayed: true'
check $? "replay is marked with the Idempotency-Replayed header"

# ---- 11. platform: usage meter + self-service keys ----
USAGE=$(curl -sS "$SITE/v2/platform/usage")
echo "$USAGE" | jq -e '.data.partyLine.quota == 2500 and (.data.partyLine.used >= 0)' > /dev/null
check $? "/v2/platform/usage is keyless and reads the demo plan's meter"
CODE=$(curl -sS -o /tmp/apx-badkey -w '%{http_code}' -X POST "$SITE/v2/platform/keys" \
  -H 'content-type: application/json' -d '{"label":"NOT VALID!!"}')
[ "$CODE" = "400" ] && jq -e '.error == "validation_failed"' /tmp/apx-badkey > /dev/null
check $? "bad key label rejected 400 by the gateway validator"
MINTED=$(curl -sS -X POST "$SITE/v2/platform/keys" -H 'content-type: application/json' -d '{"label":"verify-run"}')
MINTED_KEY=$(echo "$MINTED" | jq -r '.data.apiKey')
[ -n "$MINTED_KEY" ] && [ "$MINTED_KEY" != "null" ]; check $? "self-service mint returns a personal key (201)"
# A brand-new key takes a minute or two to reach the gateway's distributed
# key cache (measured ~65s steady-state; longer right after infra changes).
MINT_OK=1
for i in $(seq 1 30); do
  CODE=$(curl -sS -o /dev/null -w '%{http_code}' -H "x-api-key: $MINTED_KEY" "$SITE/v2/facilities?limit=1")
  [ "$CODE" = "200" ] && { MINT_OK=0; break; }
  sleep 6
done
check $MINT_OK "minted key admits requests on the visitor plan (200 within $((i*6))s)"

# ---- 12. async exports (202 + Location → poll → presigned download) ----
CODE=$(curl -sS -o /tmp/apx-badexp -w '%{http_code}' -X POST "$SITE/v2/exports" \
  -H "x-api-key: $PARTNER_KEY" -H 'content-type: application/json' -d '{"service":"everything","format":"xml"}')
[ "$CODE" = "400" ] && jq -e '.error == "validation_failed"' /tmp/apx-badexp > /dev/null
check $? "bad export request rejected 400 by the gateway validator"
ACCEPT_CODE=$(curl -sS -D /tmp/apx-exp-headers -o /tmp/apx-exp-body -w '%{http_code}' -X POST "$SITE/v2/exports" \
  -H "x-api-key: $PARTNER_KEY" -H 'content-type: application/json' -d '{"service":"facilities","format":"json"}')
JOB_PATH=$(tr -d '\r' < /tmp/apx-exp-headers | awk 'tolower($1)=="location:"{print $2}')
[ "$ACCEPT_CODE" = "202" ] && [ -n "$JOB_PATH" ]; check $? "export accepted 202 with a Location header ($JOB_PATH)"
EXPORT_OK=1
for i in $(seq 1 15); do
  JOB=$(curl -sS -H "x-api-key: $PARTNER_KEY" "$SITE$JOB_PATH")
  JSTATUS=$(echo "$JOB" | jq -r '.data.status')
  [ "$JSTATUS" = "done" ] && { EXPORT_OK=0; break; }
  [ "$JSTATUS" = "failed" ] && break
  sleep 2
done
check $EXPORT_OK "job reached done via polling (status: $JSTATUS)"
DL_URL=$(echo "$JOB" | jq -r '.data.downloadUrl')
curl -sS "$DL_URL" | jq -e '.count == 24 and (.items | length == 24)' > /dev/null
check $? "presigned download serves the full facilities catalog (24 records)"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" = "0" ]
