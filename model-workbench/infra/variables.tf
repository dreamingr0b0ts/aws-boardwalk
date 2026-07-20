variable "custom_domain_enabled" {
  description = "Attach models.demos.planetek.org + the wildcard cert. Default MUST match live state — CI applies with defaults only."
  type        = bool
  default     = true
}

variable "zone_name" {
  description = "Existing Route53 zone (created by ../platform)"
  type        = string
  default     = "demos.planetek.org"
}

variable "site_hostname" {
  description = "Public hostname for this plank's site"
  type        = string
  default     = "models.demos.planetek.org"
}

# Like planks 6 and 7, this plank's credential is deliberately NOT printed on
# the site and NOT committed: every run fans one prompt out to up to four
# foundation models, and each of those invocations costs real tokens. The
# owner hands the credential out during demos/proposals.
variable "demo_email" {
  type    = string
  default = "workbench@demo.planetek.org"
}

variable "demo_password" {
  description = "Demo user password. Local deploys pass it from the gitignored .demo-creds; when empty (CI), it is read from the SSM parameter /boardwalk/model-workbench/demo-password, which `make creds` keeps in sync."
  type        = string
  sensitive   = true
  default     = ""
}

# ---- AI cost guardrails (defense in depth behind the Cognito gate) ----

variable "user_daily_limit" {
  description = "Max comparison runs per user per UTC day (a run = up to 4 model invocations)"
  type        = number
  default     = 30
}

variable "global_daily_limit" {
  description = "Max runs across ALL users per UTC day — the kill switch that bounds worst-case daily Bedrock spend to ~$2-3 even if a credential leaks"
  type        = number
  default     = 120
}

variable "max_output_tokens" {
  description = "Hard per-model output-token ceiling per run (also bounds the cost math above)"
  type        = number
  default     = 500
}
