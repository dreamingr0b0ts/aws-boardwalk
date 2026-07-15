variable "custom_domain_enabled" {
  description = "Attach ops.demos.planetek.org + wildcard cert to CloudFront. The zone and cert already exist (created by ../platform), so this defaults on."
  type        = bool
  default     = true
}

variable "site_hostname" {
  description = "Public hostname for this plank's ops status page"
  type        = string
  default     = "ops.demos.planetek.org"
}

variable "zone_name" {
  description = "Shared boardwalk hosted zone (created by ../platform)"
  type        = string
  default     = "demos.planetek.org"
}

variable "state_bucket" {
  description = "Terraform state bucket shared by all planks — used here to read the other planks' outputs for the dashboard/canary/runbook targets. Passed by the Makefile; never hardcoded."
  type        = string
}

variable "github_repo" {
  description = "GitHub org/repo allowed to assume the CI roles via OIDC"
  type        = string
  default     = "dreamingr0b0ts/aws-boardwalk"
}

variable "github_owner_id" {
  description = "Immutable numeric ID of the GitHub owner (curl -s https://api.github.com/users/<owner> | jq .id) — part of the OIDC sub claim"
  type        = string
  default     = "208895789"
}

variable "github_repo_id" {
  description = "Immutable numeric ID of the repo (curl -s https://api.github.com/repos/<owner>/<repo> | jq .id) — part of the OIDC sub claim"
  type        = string
  default     = "1301699070"
}

variable "alarm_email" {
  description = "Where CloudWatch alarms land. The SNS subscription must be confirmed once by clicking the link AWS emails."
  type        = string
  default     = "info@planetek.org"
}

variable "drill_table_name" {
  description = "Ephemeral DynamoDB table the backup/restore drill restores into (created and deleted by each run)"
  type        = string
  default     = "ops-restore-drill"
}
