# Exhibit 3 — GuardDuty threat detection. `make demo` populates it with
# AWS-generated sample findings (every supported finding type; the console
# labels them "[SAMPLE]", the API marks them "sample": true) so the severity
# histogram has something real to show without anyone attacking anything.
#
# This root no longer owns the detector. An account gets one per region, and
# since 2026-11-14 that one is the account's own always-on detector in plank
# 10 (devops-sre/infra/account-baseline.tf). The demo borrows it: `make demo`
# seeds the practice findings into it, the evidence report counts only those,
# and `make teardown` archives them again (scripts/archive-samples.sh) so the
# detector is left holding nothing but whatever is real. Plank 10's alert rule
# excludes practice findings, so a demo window mails nobody.

data "aws_guardduty_detector" "account" {}
