# Exhibit 4 — Security Hub as the single pane: AWS Foundational Security
# Best Practices checks run against the whole account (including the nine
# always-on planks), and GuardDuty findings flow in automatically.
# enable_default_standards=false so exactly one standard is subscribed,
# deliberately, by Terraform.

resource "aws_securityhub_account" "main" {
  enable_default_standards  = false
  control_finding_generator = "SECURITY_CONTROL"
  auto_enable_controls      = true
}

resource "aws_securityhub_standards_subscription" "fsbp" {
  standards_arn = "arn:aws:securityhub:${local.region}::standards/aws-foundational-security-best-practices/v/1.0.0"

  depends_on = [aws_securityhub_account.main]
}
