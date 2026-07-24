#!/usr/bin/env bash
# End-to-end verification of the deployed environment: public pages and API,
# authentication, RBAC boundaries, and a full citizen-submit → admin-approve
# round trip. Exits non-zero if anything fails.
set -uo pipefail
cd "$(dirname "$0")/.."

TF="terraform -chdir=infra"
BASE="${VERIFY_BASE:-https://$($TF output -raw cloudfront_domain)}"
POOL=$($TF output -raw user_pool_id)
CLIENT=$($TF output -raw user_pool_client_id)

ADMIN_EMAIL="admin@demo.planetek.org"
ADMIN_PASS="Alpenglow-Admin1!"
CITIZEN_EMAIL="citizen@demo.planetek.org"
CITIZEN_PASS="Alpenglow-Citizen1!"

PASS=0
FAIL=0

ok()   { echo "  PASS  $1"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

token() {
  aws cognito-idp admin-initiate-auth \
    --user-pool-id "$POOL" --client-id "$CLIENT" \
    --auth-flow ADMIN_USER_PASSWORD_AUTH \
    --auth-parameters "USERNAME=$1,PASSWORD=$2" \
    --query 'AuthenticationResult.IdToken' --output text 2>/dev/null
}

echo "Verifying $BASE"

echo "— static delivery —"
curl -fsS "$BASE/" | grep -q 'Alpenglow' || [ $? -eq 141 ] && ok "index.html served" || bad "index.html served"
curl -fsS "$BASE/dashboard" | grep -q 'Alpenglow' || [ $? -eq 141 ] && ok "SPA deep link rewrites to index.html" || bad "SPA deep link"
curl -fsS "$BASE/config.json" | jq -e '.userPoolId' > /dev/null && ok "runtime config.json present" || bad "config.json"
curl -fsSI "$BASE/" | grep -qi 'strict-transport-security' || [ $? -eq 141 ] && ok "security headers (HSTS)" || bad "security headers"

echo "— public API (guest) —"
curl -fsS "$BASE/api/public/permit-types" | jq -e '.types | length >= 6' > /dev/null \
  && ok "permit catalog returns 6+ types" || bad "permit catalog"
curl -fsS "$BASE/api/public/stats" | jq -e '.current.total >= 30 and (.monthly | length == 12)' > /dev/null \
  && ok "public stats (current + 12 months)" || bad "public stats"

echo "— authentication boundary —"
[ "$(code "$BASE/api/me/applications")" = "401" ] && ok "no token → 401" || bad "no token → 401"

CIT=$(token "$CITIZEN_EMAIL" "$CITIZEN_PASS")
[ -n "$CIT" ] && [ "$CIT" != "None" ] && ok "citizen sign-in mints JWT" || bad "citizen sign-in"
ADM=$(token "$ADMIN_EMAIL" "$ADMIN_PASS")
[ -n "$ADM" ] && [ "$ADM" != "None" ] && ok "admin sign-in mints JWT" || bad "admin sign-in"

echo "— RBAC —"
curl -fsS -H "Authorization: Bearer $CIT" "$BASE/api/me/applications" | jq -e '.applications | length >= 1' > /dev/null \
  && ok "citizen sees own applications" || bad "citizen own applications"
[ "$(code -H "Authorization: Bearer $CIT" "$BASE/api/admin/applications")" = "403" ] \
  && ok "citizen blocked from admin API (403)" || bad "citizen blocked from admin API"
curl -fsS -H "Authorization: Bearer $ADM" "$BASE/api/admin/applications" | jq -e '.applications | length >= 10' > /dev/null \
  && ok "admin sees full queue" || bad "admin queue"

echo "— citizen → admin round trip —"
NEW_ID=$(curl -fsS -X POST -H "Authorization: Bearer $CIT" -H 'content-type: application/json' \
  -d '{"typeSlug":"home-business","address":"100 Verification Way, Alpenglow, CO","description":"Automated end-to-end verification application."}' \
  "$BASE/api/me/applications" | jq -r '.id')
[ -n "$NEW_ID" ] && [ "$NEW_ID" != "null" ] && ok "citizen submits application ($NEW_ID)" || bad "citizen submit"

echo "— attachments (presigned upload) —"
PRESIGN=$(curl -fsS -X POST -H "Authorization: Bearer $CIT" -H 'content-type: application/json' \
  -d '{"filename":"site-plan.pdf","contentType":"application/pdf"}' \
  "$BASE/api/me/applications/$NEW_ID/attachments")
ATT_ID=$(echo "$PRESIGN" | jq -r '.attachmentId')
UP_URL=$(echo "$PRESIGN" | jq -r '.upload.url')

DOC=$(mktemp -t verify-doc).pdf
printf '%%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%%%EOF\n' > "$DOC"
FORM_ARGS=()
while IFS= read -r kv; do FORM_ARGS+=(-F "$kv"); done < <(echo "$PRESIGN" | jq -r '.upload.fields | to_entries[] | "\(.key)=\(.value)"')
UP_CODE=$(curl -s -o /dev/null -w '%{http_code}' "${FORM_ARGS[@]}" -F "file=@$DOC;type=application/pdf" "$UP_URL")
rm -f "$DOC"
[ "$UP_CODE" = "204" ] && ok "browser-style presigned POST to S3 (204)" || bad "presigned POST upload (got $UP_CODE)"

CONFIRMED=$(curl -fsS -X POST -H "Authorization: Bearer $CIT" \
  "$BASE/api/me/applications/$NEW_ID/attachments/$ATT_ID/confirm" | jq -r '.status')
[ "$CONFIRMED" = "uploaded" ] && ok "attachment confirmed + logged to the record" || bad "attachment confirm"

DECIDED=$(curl -fsS -X POST -H "Authorization: Bearer $ADM" -H 'content-type: application/json' \
  -d '{"action":"approve","note":"Verified by automated smoke test."}' \
  "$BASE/api/admin/applications/$NEW_ID/decision" | jq -r '.status')
[ "$DECIDED" = "approved" ] && ok "admin approves it" || bad "admin approve"

FINAL=$(curl -fsS -H "Authorization: Bearer $CIT" "$BASE/api/me/applications/$NEW_ID" | jq -r '.application.status')
[ "$FINAL" = "approved" ] && ok "citizen sees the decision + timeline" || bad "citizen sees decision"

echo "— public register check + notifications —"
VERIFIED=$(curl -fsS "$BASE/api/public/verify/$NEW_ID" | jq -r '.record.status')
[ "$VERIFIED" = "approved" ] && ok "public register verifies the permit (no auth)" || bad "public verify"
[ "$(code "$BASE/api/public/verify/APP-DOESNOTEXIST")" = "404" ] \
  && ok "unknown permit number → 404" || bad "unknown permit number 404"
curl -fsS -H "Authorization: Bearer $CIT" "$BASE/api/me/notifications" \
  | jq -e --arg id "$NEW_ID" '.notifications | map(.appId) | index($id) != null' > /dev/null \
  && ok "decision rang the citizen's notification bell" || bad "notification delivered"

echo
echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
