variable "custom_domain_enabled" {
  description = "Attach assistant.demos.planetek.org + wildcard cert to CloudFront. The zone and cert already exist (created by ../platform for plank 1), so this defaults on."
  type        = bool
  default     = true
}

variable "site_hostname" {
  description = "Public hostname for this plank"
  type        = string
  default     = "assistant.demos.planetek.org"
}

variable "zone_name" {
  description = "Shared boardwalk hosted zone (created by ../platform)"
  type        = string
  default     = "demos.planetek.org"
}

# Unlike plank 1, this plank's credentials are deliberately NOT printed on the
# login screen and NOT committed to the repo: every chat message costs real
# Bedrock tokens, so anonymous strangers must not be able to walk in. The
# owner hands the credential out during demos/proposals. The password lives in
# the untracked .demo-creds file and is passed in by the Makefile.
variable "demo_email" {
  type    = string
  default = "assistant@demo.planetek.org"
}

variable "demo_password" {
  type      = string
  sensitive = true
}

# ---- AI cost guardrails (defense in depth behind the Cognito gate) ----

variable "model_id" {
  description = "Bedrock model for answers. Haiku 4.5 via the us. cross-region inference profile — cheapest capable Claude; bump for high-stakes demos."
  type        = string
  default     = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
}

variable "embed_model_id" {
  description = "Bedrock embeddings model (fractions of a cent per corpus ingest)"
  type        = string
  default     = "amazon.titan-embed-text-v2:0"
}

variable "user_daily_limit" {
  description = "Max chat messages per user per UTC day"
  type        = number
  default     = 40
}

variable "global_daily_limit" {
  description = "Max chat messages across ALL users per UTC day — the kill switch that bounds worst-case daily Bedrock spend to ~$2 even if a credential leaks"
  type        = number
  default     = 200
}
