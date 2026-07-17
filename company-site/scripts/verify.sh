#!/usr/bin/env bash
# End-to-end verification for the company site. Run from company-site/.
#   ./scripts/verify.sh            — full suite against the live URL
#   SEND=1 ./scripts/verify.sh     — additionally sends one real test email
set -uo pipefail

TF="terraform -chdir=infra"
PASS=0; FAIL=0

check() { # check <name> <ok:0|1>
  if [ "$2" -eq 0 ]; then PASS=$((PASS+1)); echo "  ✅ $1"; else FAIL=$((FAIL+1)); echo "  ❌ $1"; fi
}

URL=$($TF output -raw site_url)
DIST_DOMAIN=$($TF output -raw distribution_domain)
ZONE_ID=$($TF output -raw zone_id)
CERT_ARN=$($TF output -raw cert_arn)
echo "Verifying $URL"

# Test the real CloudFront stack under its own hostname regardless of public
# DNS. Before the GoDaddy nameserver cutover, planetek.org still resolves to
# the old droplet, so force the apex + www hosts to the distribution. This is
# a no-op once DNS points here. (bash word-splits $CURL, which curl needs.)
HOST=${URL#https://}
if [ "$HOST" = "planetek.org" ]; then
  CURL="--connect-to planetek.org:443:$DIST_DOMAIN:443 --connect-to www.planetek.org:443:$DIST_DOMAIN:443"
else
  CURL=""
fi

# --- static site --------------------------------------------------------------
BODY=$(curl -sS $CURL "$URL/")
HDRS=$(curl -sSI $CURL "$URL/")

echo "$BODY" | grep -q "Managed AWS Services" ; check "homepage serves and leads with Managed AWS" $?
echo "$BODY" | grep -q "Federal IT Contracting &amp; Consulting" ; check "federal section present" $?
echo "$BODY" | grep -q "demos.planetek.org" ; check "links to the demo hub" $?
echo "$HDRS" | grep -qi "strict-transport-security" ; check "HSTS header" $?
echo "$HDRS" | grep -qi "content-security-policy" ; check "CSP header" $?
echo "$HDRS" | grep -qi "x-content-type-options" ; check "nosniff header" $?

# --- SEO ----------------------------------------------------------------------
echo "$BODY" | grep -q "<title>Managed AWS Services" ; check "SEO title" $?
echo "$BODY" | grep -q 'name="description"' ; check "meta description" $?
echo "$BODY" | grep -q 'rel="canonical" href="https://planetek.org/"' ; check "canonical URL" $?
echo "$BODY" | grep -q 'property="og:image"' ; check "OpenGraph tags" $?
echo "$BODY" | grep -q 'application/ld+json' ; check "JSON-LD structured data" $?
curl -sS $CURL "$URL/robots.txt" | grep -q "Sitemap:" ; check "robots.txt with sitemap" $?
curl -sS $CURL "$URL/sitemap.xml" | grep -q "<urlset" ; check "sitemap.xml" $?
curl -sS $CURL "$URL/assets/og.jpg" -o /dev/null -w "%{http_code}" | grep -q 200 ; check "og image serves" $?

# --- routing ------------------------------------------------------------------
curl -sS $CURL "$URL/privacy" | grep -q "Privacy Policy" ; check "clean URL /privacy" $?
curl -sS $CURL "$URL/terms" | grep -q "Terms of Service" ; check "clean URL /terms" $?
[ "$(curl -sS $CURL -o /dev/null -w '%{http_code}' "$URL/no-such-page")" = "404" ] ; check "unknown path returns 404" $?

# --- contact API --------------------------------------------------------------
HP=$(curl -sS $CURL -X POST "$URL/api/contact" -H 'content-type: application/json' \
  -d '{"name":"Bot","email":"bot@example.com","message":"spam spam spam","website":"http://spam"}')
echo "$HP" | grep -q '"ok":true' ; check "honeypot swallowed silently" $?

BAD=$(curl -sS $CURL -o /dev/null -w '%{http_code}' -X POST "$URL/api/contact" \
  -H 'content-type: application/json' -d '{"name":"","email":"nope","message":"hi"}')
[ "$BAD" = "400" ] ; check "invalid submission rejected (400)" $?

if [ "${SEND:-0}" = "1" ]; then
  OK=$(curl -sS $CURL -X POST "$URL/api/contact" -H 'content-type: application/json' \
    -d '{"name":"Verify Script","email":"info@planetek.org","service":"Other","message":"Test submission from scripts/verify.sh — safe to ignore."}')
  echo "$OK" | grep -q '"ok":true' ; check "real submission accepted (check the info@ inbox)" $?
fi

# --- DNS zone contents --------------------------------------------------------
RRS=$(aws route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" --output json)
echo "$RRS" | grep -q "mx01.mail.icloud.com" ; check "iCloud MX records replicated" $?
echo "$RRS" | grep -q "v=spf1 include:icloud.com" ; check "SPF record replicated" $?
echo "$RRS" | grep -q "sig1.dkim.planetek.org.at.icloudmailadmin.com" ; check "iCloud DKIM CNAME replicated" $?
echo "$RRS" | grep -q "v=DMARC1" ; check "DMARC record present" $?
echo "$RRS" | grep -q "awsdns" ; check "demos.planetek.org NS delegation present" $?
echo "$RRS" | grep -q "164.92.95.230" ; check "drift.planetek.org legacy record present" $?
echo "$RRS" | grep -q "dkim.amazonses.com" ; check "SES DKIM CNAMEs present" $?
APEX_ALIAS=$(echo "$RRS" | python3 -c "import json,sys; rrs=json.load(sys.stdin)['ResourceRecordSets']; print(sum(1 for r in rrs if r['Name']=='planetek.org.' and r['Type'] in ('A','AAAA') and 'AliasTarget' in r))")
[ "$APEX_ALIAS" = "2" ] ; check "apex A/AAAA alias → CloudFront" $?

# --- cert + SES status (informational until cutover) --------------------------
CERT_STATUS=$(aws acm describe-certificate --certificate-arn "$CERT_ARN" --query Certificate.Status --output text)
echo "  ℹ️  ACM cert status: $CERT_STATUS"
[ -n "$CERT_STATUS" ] ; check "ACM certificate exists" $?

SES_STATUS=$(aws sesv2 get-email-identity --email-identity info@planetek.org --query VerifiedForSendingStatus --output text 2>/dev/null)
echo "  ℹ️  SES info@planetek.org verified: $SES_STATUS"
[ -n "$SES_STATUS" ] ; check "SES identity exists" $?

# --- custom domain (only once enabled + cut over) -----------------------------
ENABLED=$($TF output -raw site_url | grep -c "https://planetek.org")
if [ "$ENABLED" = "1" ]; then
  W=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --connect-to "www.planetek.org:443:$DIST_DOMAIN:443" "https://www.planetek.org/")
  echo "$W" | grep -q "301 https://planetek.org" ; check "www → apex 301" $?
fi

echo
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
