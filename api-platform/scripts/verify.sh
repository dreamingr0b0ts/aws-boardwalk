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
echo "$HDRS" | grep -qi "strict-transport-security"; check $? "HSTS header present"
echo "$HDRS" | grep -qi "content-security-policy"; check $? "CSP header present"

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
echo "$STATUS" | jq -e '[.services[].name] | sort == ["facilities","licenses","permits"]' > /dev/null
check $? "status reports all three microservices"
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

# ---- 8. usage-plan throttling (demo tier: 5 rps / burst 10) ----
BURST=$(seq 1 40 | xargs -P 20 -I{} curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "x-api-key: $DEMO_KEY" "$SITE/v2/facilities?limit=1")
N429=$(echo "$BURST" | grep -c '^429' || true)
N200=$(echo "$BURST" | grep -c '^200' || true)
[ "$N429" -ge 1 ] && [ "$N200" -ge 1 ]; check $? "40-request burst drew usage-plan 429s ($N200 × 200, $N429 × 429)"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" = "0" ]
