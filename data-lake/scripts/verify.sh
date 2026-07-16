#!/usr/bin/env bash
# End-to-end verification against the LIVE deployment. The plank isn't done
# until every check here passes — including the ones that prove the lake is
# doing real analytics work: partition pruning must actually cut the bytes
# scanned, the raw-vs-curated gap must be real, and the result cache and the
# daily Athena budget must both be observable.
set -uo pipefail
cd "$(dirname "$0")/.."

TF="terraform -chdir=infra"
SITE=$($TF output -raw site_url)
WORKGROUP=$($TF output -raw workgroup)
GLUE_DB=$($TF output -raw glue_database)
RAW_TABLE=$($TF output -raw raw_table)
CURATED_TABLE=$($TF output -raw curated_table)
LAKE=$($TF output -raw lake_bucket)
RAW_PREFIX=$($TF output -raw raw_prefix)
CURATED_PREFIX=$($TF output -raw curated_prefix)

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
check(){ if [ "$1" = "0" ]; then ok "$2"; else bad "$2"; fi }

run_query() { # usage: run_query <id> -> RESP
  RESP=$(curl -sS -X POST "$SITE/api/query" -H 'content-type: application/json' -d "{\"id\":\"$1\"}")
  echo "$RESP" | jq -e '.rows | length > 0' > /dev/null
}

echo "verifying $SITE"

# ---- 1. static site + security headers ----
HDRS=$(curl -sS -D - -o /tmp/dla-index.html "$SITE/" | tr -d '\r')
grep -q "Colorado Business Data Lake" /tmp/dla-index.html; check $? "site serves the data lake dashboard"
echo "$HDRS" | grep -qi "strict-transport-security"; check $? "HSTS header present"
echo "$HDRS" | grep -qi "content-security-policy"; check $? "CSP header present"

# ---- 2. the lake itself (catalog, zones, format) ----
WG=$(aws athena get-work-group --work-group "$WORKGROUP" --output json)
echo "$WG" | jq -e '.WorkGroup.Configuration.EnforceWorkGroupConfiguration == true' > /dev/null
check $? "workgroup enforces its configuration"
echo "$WG" | jq -e '.WorkGroup.Configuration.BytesScannedCutoffPerQuery > 0' > /dev/null
check $? "workgroup has a per-query scan cutoff"

aws glue get-table --database-name "$GLUE_DB" --name "$RAW_TABLE" > /dev/null 2>&1
check $? "raw table is in the Glue catalog"
CURATED_JSON=$(aws glue get-table --database-name "$GLUE_DB" --name "$CURATED_TABLE" --output json 2>/dev/null)
[ -n "$CURATED_JSON" ]; check $? "curated table is in the Glue catalog (CTAS registered it)"
echo "$CURATED_JSON" | jq -e '.Table.StorageDescriptor.InputFormat | test("Parquet"; "i")' > /dev/null
check $? "curated table is Parquet"
# (--output json + jq, not --query length(): the CLI can emit one count per
# result page, which breaks the integer comparison)
NPART=$(aws glue get-partitions --database-name "$GLUE_DB" --table-name "$CURATED_TABLE" \
  --output json 2>/dev/null | jq '.Partitions | length')
[ "${NPART:-0}" -ge 15 ]; check $? "curated table has decade partitions ($NPART)"

NRAW=$(aws s3api list-objects-v2 --bucket "$LAKE" --prefix "$RAW_PREFIX/" --query 'length(Contents)' --output text)
[ "${NRAW:-0}" -ge 10 ]; check $? "raw zone holds the ingested snapshot ($NRAW objects)"
aws s3api list-objects-v2 --bucket "$LAKE" --prefix "$CURATED_PREFIX/" --query 'Contents[0].Key' --output text | grep -q "decade="
check $? "curated zone is laid out as decade= partition folders"

# ---- 3. summary API (precomputed analytics) ----
SUMMARY=$(curl -sS "$SITE/api/summary")
ROWS=$(echo "$SUMMARY" | jq '.manifest.totalRows')
[ "$ROWS" -ge 3000000 ]; check $? "manifest reports the full dataset ($ROWS rows)"
echo "$SUMMARY" | jq -e '.manifest.countScannedBytes == 0' > /dev/null
check $? "count(*) over Parquet scanned zero bytes (metadata answered it)"
echo "$SUMMARY" | jq -e '.formations_by_year.rows | length >= 30' > /dev/null
check $? "formations-by-year aggregate is populated"
echo "$SUMMARY" | jq -e '(.entity_types.rows | length >= 5) and (.cohort_survival.rows | length >= 20)' > /dev/null
check $? "entity-type and cohort-survival aggregates are populated"
# (Parquet+Snappy is often LARGER at rest than gzipped JSONL — the lake's win
# is bytes SCANNED per query, which section 6 proves — so only assert both
# zones are populated and measured here.)
CUR_BYTES=$(echo "$SUMMARY" | jq '.manifest.curated.bytes')
RAW_BYTES=$(echo "$SUMMARY" | jq '.manifest.raw.bytes')
[ "$CUR_BYTES" -gt 0 ] && [ "$RAW_BYTES" -gt 0 ]
check $? "manifest measured both zones (raw $RAW_BYTES, curated $CUR_BYTES bytes)"

# ---- 4. live query catalog ----
CATALOG=$(curl -sS "$SITE/api/queries")
echo "$CATALOG" | jq -e '.queries | length >= 7' > /dev/null; check $? "query catalog lists its entries"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SITE/api/query" \
  -H 'content-type: application/json' -d '{"id":"drop-table-students"}')
[ "$CODE" = "400" ]; check $? "unknown query id is rejected (400) — no arbitrary SQL"

# ---- 5. live execution: stats, cost, partition pruning ----
run_query formations-recent; check $? "formations-recent returns rows"
SCANNED=$(echo "$RESP" | jq '.stats.bytesScanned')
[ "$SCANNED" -gt 0 ]; check $? "Athena reported bytes scanned ($SCANNED)"
echo "$RESP" | jq -e '.stats.estCostUsd <= 0.01' > /dev/null
check $? "query cost a fraction of a cent (\$$(echo "$RESP" | jq -r '.stats.estCostUsd'))"
[ "$SCANNED" -lt $((CUR_BYTES / 2)) ]
check $? "partition pruning cut the scan (scanned $SCANNED of $CUR_BYTES curated bytes)"

run_query formations-recent; check $? "second run returns rows"
echo "$RESP" | jq -e '.cached == true' > /dev/null
check $? "second run was a cache hit (Athena not re-run)"

# ---- 6. the raw-vs-curated race ----
run_query zone-curated; check $? "status counts over curated Parquet"
CUR_SCAN=$(echo "$RESP" | jq '.stats.bytesScanned')
run_query zone-raw; check $? "identical query over raw gzipped JSON"
RAW_SCAN=$(echo "$RESP" | jq '.stats.bytesScanned')
[ "$RAW_SCAN" -gt $((CUR_SCAN * 3)) ]
check $? "columnar won: raw scanned ${RAW_SCAN}, curated scanned ${CUR_SCAN}"

# ---- 7. the daily Athena budget is counting ----
USAGE=$(curl -sS "$SITE/api/summary" | jq '.usage')
echo "$USAGE" | jq -e '.used >= 3 and .limit == 150' > /dev/null
check $? "global daily execution counter advanced ($(echo "$USAGE" | jq -r '.used')/150)"

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" = "0" ]
