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

echo "$BODY" | grep -q "Managed AWS Services" || [ $? -eq 141 ] ; check "homepage serves and leads with Managed AWS" $?
echo "$BODY" | grep -q "Federal IT Contracting &amp; Consulting" || [ $? -eq 141 ] ; check "federal section present" $?
echo "$BODY" | grep -q "demos.planetek.org" || [ $? -eq 141 ] ; check "links to the demo hub" $?
echo "$BODY" | grep -q 'href="/managed-aws"' || [ $? -eq 141 ] ; check "homepage routes to the service pages" $?
echo "$BODY" | grep -q 'href="/insights/what-twelve-aws-environments-cost"' || [ $? -eq 141 ] ; check "homepage field-notes strip present" $?
echo "$HDRS" | grep -qi "strict-transport-security" || [ $? -eq 141 ] ; check "HSTS header" $?
echo "$HDRS" | grep -qi "content-security-policy" || [ $? -eq 141 ] ; check "CSP header" $?
echo "$HDRS" | grep -qi "x-content-type-options" || [ $? -eq 141 ] ; check "nosniff header" $?

# --- SEO ----------------------------------------------------------------------
echo "$BODY" | grep -q "<title>Managed AWS Services" || [ $? -eq 141 ] ; check "SEO title" $?
echo "$BODY" | grep -q 'name="description"' || [ $? -eq 141 ] ; check "meta description" $?
echo "$BODY" | grep -q 'rel="canonical" href="https://planetek.org/"' || [ $? -eq 141 ] ; check "canonical URL" $?
echo "$BODY" | grep -q 'property="og:image"' || [ $? -eq 141 ] ; check "OpenGraph tags" $?
echo "$BODY" | grep -q 'application/ld+json' || [ $? -eq 141 ] ; check "JSON-LD structured data" $?
curl -sS $CURL "$URL/robots.txt" | grep -q "Sitemap:" || [ $? -eq 141 ] ; check "robots.txt with sitemap" $?
curl -sS $CURL "$URL/sitemap.xml" | grep -q "<urlset" || [ $? -eq 141 ] ; check "sitemap.xml" $?
curl -sS $CURL "$URL/feed.xml" | grep -q "<rss" || [ $? -eq 141 ] ; check "RSS feed" $?
python3 ../tools/check_field_notes.py ; check "field-note surfaces in sync (repo)" $?
curl -sS $CURL "$URL/assets/og.jpg" -o /dev/null -w "%{http_code}" | grep -q 200 || [ $? -eq 141 ] ; check "og image serves" $?

# --- routing ------------------------------------------------------------------
# Capture then grep: piping curl straight into grep -q races once the page is
# bigger than one read chunk (grep exits early, curl exits 23, not 141).
PRIV=$(curl -sS $CURL "$URL/privacy")
echo "$PRIV" | grep -q "Privacy Policy" || [ $? -eq 141 ] ; check "clean URL /privacy" $?
TOS=$(curl -sS $CURL "$URL/terms")
echo "$TOS" | grep -q "Terms of Service" || [ $? -eq 141 ] ; check "clean URL /terms" $?
curl -sS $CURL -o /dev/null -w "%{http_code}" "$URL/definitely-not-a-page" | grep -q 404 || [ $? -eq 141 ] ; check "missing pages return 404" $?
[ "$(curl -sS $CURL -o /dev/null -w '%{http_code}' "$URL/no-such-page")" = "404" ] ; check "unknown path returns 404" $?

# --- service pages + insights ---------------------------------------------------
AWSPAGE=$(curl -sS $CURL "$URL/managed-aws")
echo "$AWSPAGE" | grep -q "Managed AWS services from Colorado" || [ $? -eq 141 ] ; check "service page /managed-aws" $?
echo "$AWSPAGE" | grep -q 'rel="canonical" href="https://planetek.org/managed-aws"' || [ $? -eq 141 ] ; check "canonical on /managed-aws" $?
FED=$(curl -sS $CURL "$URL/federal")
echo "$FED" | grep -q "Federal IT contracting" || [ $? -eq 141 ] ; check "service page /federal" $?
echo "$FED" | grep -q 'href="/assets/Planetek_Capability_Statement_Federal.pdf"' || [ $? -eq 141 ] ; check "federal page links the capability statement download" $?
FRAC=$(curl -sS $CURL "$URL/fractional-cto")
echo "$FRAC" | grep -q "Fractional CTO, CIO" || [ $? -eq 141 ] ; check "service page /fractional-cto" $?
TRAIN=$(curl -sS $CURL "$URL/ai-training")
echo "$TRAIN" | grep -q "AI enablement for working teams" || [ $? -eq 141 ] ; check "service page /ai-training" $?
WEBDEV=$(curl -sS $CURL "$URL/web-development")
echo "$WEBDEV" | grep -q "Application delivery on AWS" || [ $? -eq 141 ] ; check "service page /web-development" $?
INS=$(curl -sS $CURL "$URL/insights")
echo "$INS" | grep -q "Insights from the field" || [ $? -eq 141 ] ; check "insights index /insights" $?
POST=$(curl -sS $CURL "$URL/insights/what-twelve-aws-environments-cost")
echo "$POST" | grep -q "What twelve live AWS environments cost" || [ $? -eq 141 ] ; check "insights post (nested clean URL)" $?
ABOUT=$(curl -sS $CURL "$URL/about")
echo "$ABOUT" | grep -q "The engineer behind every door" || [ $? -eq 141 ] ; check "about page /about serves" $?
echo "$ABOUT" | grep -q 'rel="canonical" href="https://planetek.org/about"' || [ $? -eq 141 ] ; check "canonical on /about" $?
PORTRAIT=$(curl -sS $CURL -o /dev/null -w '%{http_code}' "$URL/assets/trevor-lewis.webp")
[ "$PORTRAIT" = "200" ] ; check "founder portrait serves" $?
RESPDF=$(curl -sS $CURL -o /dev/null -w '%{http_code} %{content_type}' "$URL/assets/Trevor_Lewis_Resume.pdf")
[ "$RESPDF" = "200 application/pdf" ] ; check "resume PDF serves as application/pdf" $?
echo "$ABOUT" | grep -q 'href="/assets/Trevor_Lewis_Resume.pdf"' || [ $? -eq 141 ] ; check "about page links the resume download" $?
CSPDF=$(curl -sS $CURL -o /dev/null -w '%{http_code} %{content_type}' "$URL/assets/Planetek_Capability_Statement_Federal.pdf")
[ "$CSPDF" = "200 application/pdf" ] ; check "capability statement PDF serves as application/pdf" $?
echo "$BODY" | grep -q 'href="/about"' || [ $? -eq 141 ] ; check "homepage links to /about" $?
PCSS=$(curl -sS $CURL -o /dev/null -w '%{http_code}' "$URL/assets/pages.css")
[ "$PCSS" = "200" ] ; check "shared pages.css serves" $?
HERO=$(curl -sS $CURL -o /dev/null -w '%{http_code}' "$URL/assets/aws-village-dusk.webp")
[ "$HERO" = "200" ] ; check "interior hero photo serves" $?
POSTS_LISTED=$(echo "$INS" | grep -c "class=\"post-card\"")
[ "$POSTS_LISTED" -ge 3 ] ; check "insights index lists 3+ posts" $?

# --- apps: the product hub and its per-app pages -------------------------------
APPS=$(curl -sS $CURL "$URL/apps")
echo "$APPS" | grep -q "Apps from Planetek" || [ $? -eq 141 ] ; check "apps hub /apps serves" $?
echo "$APPS" | grep -q 'rel="canonical" href="https://planetek.org/apps"' || [ $? -eq 141 ] ; check "canonical on /apps" $?
echo "$APPS" | grep -q 'href="/apps/govcon-radar"' || [ $? -eq 141 ] ; check "apps hub links its app pages" $?
GCR=$(curl -sS $CURL "$URL/apps/govcon-radar")
echo "$GCR" | grep -q "GovCon Radar" || [ $? -eq 141 ] ; check "app page /apps/govcon-radar (nested clean URL)" $?
echo "$GCR" | grep -q 'rel="canonical" href="https://planetek.org/apps/govcon-radar"' || [ $? -eq 141 ] ; check "canonical on /apps/govcon-radar" $?
# The whole point of the page: the two store listings and the product site.
echo "$GCR" | grep -q "apps.apple.com/us/app/govcon-radar" || [ $? -eq 141 ] ; check "app page links the App Store listing" $?
echo "$GCR" | grep -q "play.google.com/store/apps/details?id=org.planetek.govconradar" || [ $? -eq 141 ] ; check "app page links the Play Store listing" $?
echo "$GCR" | grep -q "https://app.govconradar.com/" || [ $? -eq 141 ] ; check "app page links app.govconradar.com" $?
echo "$GCR" | grep -q '"@type": "SoftwareApplication"' || [ $? -eq 141 ] ; check "app page carries SoftwareApplication JSON-LD" $?
echo "$GCR" | grep -q "not affiliated with or endorsed by the U.S. Government" || [ $? -eq 141 ] ; check "app page carries the no-endorsement disclaimer" $?
for A in badges/app-store.svg badges/google-play.png govcon-radar-matches.webp govcon-radar-dish.webp; do
  [ "$(curl -sS $CURL -o /dev/null -w '%{http_code}' "$URL/assets/$A")" = "200" ] ; check "app asset serves: $A" $?
done
# Internal linking is what makes the section worth having, so it is checked,
# not assumed: the nav on every page, the footer, and a real homepage section.
echo "$BODY" | grep -q 'href="/apps"' || [ $? -eq 141 ] ; check "homepage links to /apps" $?
echo "$BODY" | grep -q "Apps we build, ship, and run" || [ $? -eq 141 ] ; check "homepage carries the apps section" $?
echo "$AWSPAGE" | grep -q '<a href="/apps">Apps</a>' || [ $? -eq 141 ] ; check "interior pages carry Apps in the nav" $?
SMAP=$(curl -sS $CURL "$URL/sitemap.xml")
echo "$SMAP" | grep -q "https://planetek.org/apps/govcon-radar" || [ $? -eq 141 ] ; check "sitemap lists the app page" $?

# --- contact API --------------------------------------------------------------
HP=$(curl -sS $CURL -X POST "$URL/api/contact" -H 'content-type: application/json' \
  -d '{"name":"Bot","email":"bot@example.com","message":"spam spam spam","website":"http://spam"}')
echo "$HP" | grep -q '"ok":true' || [ $? -eq 141 ] ; check "honeypot swallowed silently" $?

BAD=$(curl -sS $CURL -o /dev/null -w '%{http_code}' -X POST "$URL/api/contact" \
  -H 'content-type: application/json' -d '{"name":"","email":"nope","message":"hi"}')
[ "$BAD" = "400" ] ; check "invalid submission rejected (400)" $?

if [ "${SEND:-0}" = "1" ]; then
  OK=$(curl -sS $CURL -X POST "$URL/api/contact" -H 'content-type: application/json' \
    -d '{"name":"Verify Script","email":"info@planetek.org","service":"Other","message":"Test submission from scripts/verify.sh — safe to ignore."}')
  echo "$OK" | grep -q '"ok":true' || [ $? -eq 141 ] ; check "real submission accepted (check the info@ inbox)" $?
fi

# --- booking desk -------------------------------------------------------------
SCHED=$(curl -sS $CURL "$URL/schedule")
echo "$SCHED" | grep -q "Book a time straight onto our calendar" || [ $? -eq 141 ] ; check "booking page /schedule serves" $?
SJS=$(curl -sS $CURL -o /dev/null -w '%{http_code}' "$URL/assets/schedule.js")
[ "$SJS" = "200" ] ; check "schedule.js serves" $?

SLOTS=$(curl -sS $CURL "$URL/api/schedule/slots")
echo "$SLOTS" | grep -q '"timezone":"America/Denver"' || [ $? -eq 141 ] ; check "slots endpoint answers in Mountain time" $?
SLOT_COUNT=$(echo "$SLOTS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['slots']))")
[ "$SLOT_COUNT" -ge 50 ] ; check "slots endpoint offers 50+ open slots ($SLOT_COUNT)" $?

# The honeypot POST exercises the Lambda end to end without sending mail or
# taking a slot; the invalid-slot POST proves server-side slot validation.
SHP=$(curl -sS $CURL -X POST "$URL/api/schedule/book" -H 'content-type: application/json' \
  -d '{"name":"Bot","email":"bot@example.com","slot":"2030-01-07T16:00:00Z","website":"http://spam"}')
echo "$SHP" | grep -q '"ok":true' || [ $? -eq 141 ] ; check "booking honeypot swallowed silently" $?
SBAD=$(curl -sS $CURL -o /dev/null -w '%{http_code}' -X POST "$URL/api/schedule/book" \
  -H 'content-type: application/json' -d '{"name":"Verify","email":"info@planetek.org","slot":"2030-01-07T03:00:00Z"}')
[ "$SBAD" = "400" ] ; check "unavailable slot rejected (400)" $?
# The address becomes an SMTP recipient, so one that could smuggle a second
# recipient is refused before any counter, booking, or mail is touched.
SINJ=$(curl -sS $CURL -o /dev/null -w '%{http_code}' -X POST "$URL/api/schedule/book" \
  -H 'content-type: application/json' -d '{"name":"Verify","email":"a@example.com,evil","slot":"2030-01-07T16:00:00Z"}')
[ "$SINJ" = "400" ] ; check "address that could carry a second recipient rejected (400)" $?

# ---- the origin lock: the API answers CloudFront, never the open internet ----
# Straight at the execute-api hostname there is no WAF, and the caller writes
# the whole X-Forwarded-For chain the visitor caps key on. So every handler
# refuses a request that lacks the secret header only the distribution sends.
API_DIRECT=$($TF output -raw api_endpoint)
DSLOTS=$(curl -sS -o /dev/null -w '%{http_code}' "$API_DIRECT/api/schedule/slots")
[ "$DSLOTS" = "403" ] ; check "direct call to the API origin is refused: booking desk ($DSLOTS)" $?
DBOOK=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API_DIRECT/api/schedule/book" -H 'content-type: application/json' \
  -d '{"name":"Verify","email":"info@planetek.org","slot":"2030-01-07T16:00:00Z"}')
[ "$DBOOK" = "403" ] ; check "direct booking POST is refused before anything is touched ($DBOOK)" $?
DCONTACT=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API_DIRECT/api/contact" -H 'content-type: application/json' \
  -d '{"name":"Bot","email":"bot@example.com","message":"spam spam spam","website":"http://spam"}')
[ "$DCONTACT" = "403" ] ; check "direct call to the API origin is refused: contact form ($DCONTACT)" $?
GUESS=$(curl -sS -o /dev/null -w '%{http_code}' -H 'x-origin-verify: guess' "$API_DIRECT/api/schedule/slots")
[ "$GUESS" = "403" ] ; check "a guessed origin header is refused too ($GUESS)" $?
VIA=$(curl -sS $CURL -o /dev/null -w '%{http_code}' -H 'x-origin-verify: guess' "$URL/api/schedule/slots")
[ "$VIA" = "200" ] ; check "through CloudFront a viewer-sent origin header is replaced, not trusted ($VIA)" $?

# --- DNS zone contents --------------------------------------------------------
RRS=$(aws route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" --output json)
echo "$RRS" | grep -q "mx01.mail.icloud.com" || [ $? -eq 141 ] ; check "iCloud MX records replicated" $?
echo "$RRS" | grep -q "v=spf1 include:icloud.com" || [ $? -eq 141 ] ; check "SPF record replicated" $?
echo "$RRS" | grep -q "sig1.dkim.planetek.org.at.icloudmailadmin.com" || [ $? -eq 141 ] ; check "iCloud DKIM CNAME replicated" $?
echo "$RRS" | grep -q "v=DMARC1" || [ $? -eq 141 ] ; check "DMARC record present" $?
echo "$RRS" | grep -q "awsdns" || [ $? -eq 141 ] ; check "demos.planetek.org NS delegation present" $?
echo "$RRS" | grep -q "dkim.amazonses.com" || [ $? -eq 141 ] ; check "SES DKIM CNAMEs present" $?
APEX_ALIAS=$(echo "$RRS" | python3 -c "import json,sys; rrs=json.load(sys.stdin)['ResourceRecordSets']; print(sum(1 for r in rrs if r['Name']=='planetek.org.' and r['Type'] in ('A','AAAA') and 'AliasTarget' in r))")
[ "$APEX_ALIAS" = "2" ] ; check "apex A/AAAA alias → CloudFront" $?

# --- cert + SES status (informational until cutover) --------------------------
CERT_STATUS=$(aws acm describe-certificate --certificate-arn "$CERT_ARN" --query Certificate.Status --output text)
echo "  ℹ️  ACM cert status: $CERT_STATUS"
[ -n "$CERT_STATUS" ] ; check "ACM certificate exists" $?

SES_STATUS=$(aws sesv2 get-email-identity --email-identity info@planetek.org --query VerifiedForSendingStatus --output text 2>/dev/null)
echo "  ℹ️  SES info@planetek.org verified: $SES_STATUS"
[ -n "$SES_STATUS" ] ; check "SES identity exists" $?

# --- outbound-mail guardrails -------------------------------------------------
ACCT=$(aws sesv2 get-account --output json)
echo "  ℹ️  SES production access: $(echo "$ACCT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["ProductionAccessEnabled"])')"
SUPPRESSED=$(echo "$ACCT" | python3 -c 'import json,sys; r=json.load(sys.stdin)["SuppressionAttributes"]["SuppressedReasons"]; print(int("BOUNCE" in r and "COMPLAINT" in r))')
[ "$SUPPRESSED" = "1" ] ; check "account suppression list covers bounces + complaints" $?
CFGSET=$(aws sesv2 get-configuration-set --configuration-set-name www-mail --output json 2>/dev/null)
echo "$CFGSET" | grep -q '"SendingEnabled": true' || [ $? -eq 141 ] ; check "www-mail configuration set exists, sending enabled" $?
EVDEST=$(aws sesv2 get-configuration-set-event-destinations --configuration-set-name www-mail --output json 2>/dev/null)
echo "$EVDEST" | grep -q '"BOUNCE"' || [ $? -eq 141 ] ; check "bounce/complaint events routed to SNS" $?
# The visitor-confirmation flag must match what SES can actually do: never
# enabled while the account is still sandboxed.
VFLAG=$(aws lambda get-function-configuration --function-name www-schedule --query 'Environment.Variables.VISITOR_EMAIL' --output text)
PROD=$(echo "$ACCT" | python3 -c 'import json,sys; print(str(json.load(sys.stdin)["ProductionAccessEnabled"]).lower())')
echo "  ℹ️  visitor confirmations: $VFLAG"
{ [ "$VFLAG" = "false" ] || [ "$PROD" = "true" ]; } ; check "visitor email flag consistent with SES access" $?

# --- custom domain (only once enabled + cut over) -----------------------------
ENABLED=$($TF output -raw site_url | grep -c "https://planetek.org")
if [ "$ENABLED" = "1" ]; then
  W=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --connect-to "www.planetek.org:443:$DIST_DOMAIN:443" "https://www.planetek.org/")
  echo "$W" | grep -q "301 https://planetek.org" || [ $? -eq 141 ] ; check "www → apex 301" $?
fi

echo
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
