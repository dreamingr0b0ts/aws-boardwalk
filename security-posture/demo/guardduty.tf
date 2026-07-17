# Exhibit 3 — GuardDuty threat detection. `make demo` populates it with
# AWS-generated sample findings (every supported finding type, titles all
# prefixed "[SAMPLE]") so the severity histogram has something real to show
# without anyone attacking anything.

resource "aws_guardduty_detector" "main" {
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
}
