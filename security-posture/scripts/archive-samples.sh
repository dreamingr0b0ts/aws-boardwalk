#!/usr/bin/env bash
# Archive every GuardDuty PRACTICE finding in the account's detector.
#
# `make demo` seeds AWS's sample findings into the account's own always-on
# detector (plank 10 owns it; this plank borrows it). Teardown used to delete
# the detector and the samples with it. Now the detector stays, so teardown
# runs this instead: it archives the findings AWS marked as samples and
# touches nothing else, leaving the detector holding only what is real.
#
# The marker is "sample": true inside the JSON string at
# Service.AdditionalInfo.Value. (The "[SAMPLE]" title is only how the console
# displays them; the API's Title has no prefix.) A finding whose marker is
# missing or unreadable is treated as real and left alone.
#
# Archiving is all a finding allows (GuardDuty has no delete; archived
# findings age out after 90 days). The next `make demo` raises a fresh set.
# Safe to run any time, any number of times.
set -uo pipefail

DETECTOR=$(aws guardduty list-detectors --query 'DetectorIds[0]' --output text --no-cli-pager)
if [ -z "$DETECTOR" ] || [ "$DETECTOR" = "None" ]; then
  echo "no GuardDuty detector in this region: nothing to archive"
  exit 0
fi

ACTIVE='{"Criterion":{"service.archived":{"Eq":["false"]}}}'
IDS=$(aws guardduty list-findings --detector-id "$DETECTOR" --finding-criteria "$ACTIVE" \
  --query 'FindingIds' --output text --no-cli-pager | tr '\t' '\n' | grep -v '^$' | grep -v '^None$')

ARCHIVED=0
FAILED=0
# get-findings and archive-findings both take at most 50 ids a call.
while read -r BATCH; do
  [ -n "$BATCH" ] || continue
  # shellcheck disable=SC2086  # the ids are meant to split into arguments
  PRACTICE=$(aws guardduty get-findings --detector-id "$DETECTOR" --finding-ids $BATCH --output json --no-cli-pager \
    | jq -r '[.Findings[] | select(((.Service.AdditionalInfo.Value // "{}") | (try fromjson catch {})) | .sample == true) | .Id] | join(" ")')
  [ -n "$PRACTICE" ] || continue
  # shellcheck disable=SC2086
  if aws guardduty archive-findings --detector-id "$DETECTOR" --finding-ids $PRACTICE --no-cli-pager; then
    ARCHIVED=$((ARCHIVED + $(echo "$PRACTICE" | wc -w)))
  else
    FAILED=1
  fi
done < <(echo "$IDS" | xargs -n 50)

echo "archived $ARCHIVED practice finding(s) in the account's detector"
[ "$FAILED" = "0" ]
