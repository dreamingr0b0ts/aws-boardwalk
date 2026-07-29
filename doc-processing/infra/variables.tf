variable "custom_domain_enabled" {
  description = "Attach documents.demos.planetek.org + wildcard cert to CloudFront. The zone and cert already exist (created by ../platform), so this defaults on."
  type        = bool
  default     = true
}

variable "site_hostname" {
  description = "Public hostname for this plank"
  type        = string
  default     = "documents.demos.planetek.org"
}

variable "zone_name" {
  description = "Shared boardwalk hosted zone (created by ../platform)"
  type        = string
  default     = "demos.planetek.org"
}

# Same posture as plank 6: this plank's credential is deliberately NOT printed
# on the site and NOT committed — every accepted upload spends real Textract,
# Comprehend, and Bedrock money. Browsing the processed index is free and
# public; putting new documents through the pipeline requires the credential
# the owner hands out during demos.
variable "demo_email" {
  type    = string
  default = "documents@demo.planetek.org"
}

variable "demo_password" {
  description = "Demo user password. Local deploys pass it from the gitignored .demo-creds; when empty (CI), it is read from the SSM parameter /boardwalk/doc-processing/demo-password, which `make creds` keeps in sync."
  type        = string
  sensitive   = true
  default     = ""
}

variable "model_id" {
  description = "Bedrock model for document classification (one small call per document); global cross-region profile, priced at source-Region rates"
  type        = string
  default     = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
}

# ---- AI/OCR cost guardrails (defense in depth behind the Cognito gate) ----
#
# Textract FORMS is the expensive unit here (~$0.05/page), so the caps bound
# pages, not just requests: global_daily_limit × max_pages × $0.05 ≈ $9/day
# worst case even if the (unpublished) credential leaks. Size and page caps
# are enforced BEFORE any Textract job starts. The anonymous taste tier
# (5/day per hashed IP, 10/day pool) counts into the same global cap, so it
# adds reach without moving the worst-case day.

variable "user_daily_limit" {
  description = "Max accepted document uploads per signed-in user per UTC day"
  type        = number
  default     = 15
}

variable "global_daily_limit" {
  description = "Max accepted uploads across ALL users AND visitors per UTC day — the kill switch that bounds worst-case daily OCR spend"
  type        = number
  default     = 30
}

variable "anon_daily_limit" {
  description = "Max anonymous uploads per hashed viewer IP per UTC day (the no-sign-in taste tier; same fence as planks 6 and 12)"
  type        = number
  default     = 5
}

variable "anon_global_daily_limit" {
  description = "Max anonymous uploads across ALL visitors per UTC day; every one also counts against global_daily_limit"
  type        = number
  default     = 10
}

variable "max_upload_bytes" {
  description = "Per-file size cap, enforced in the presigned POST conditions and re-checked by the pipeline"
  type        = number
  default     = 4194304 # 4 MB
}

variable "max_pages" {
  description = "Per-document page cap, checked by parsing the PDF before the Textract job is started"
  type        = number
  default     = 6
}

# ---- processing receipt prices (display math only, never billing logic) ----
#
# Every document's record carries an itemized receipt of what its run cost.
# Sources (verified 2026-07-29): Textract Analyze Document FORMS tier 1 =
# $0.05/page; Comprehend DetectEntities and DetectPiiEntities = $0.0001 per
# 100-char unit, 3-unit minimum per request; Claude Haiku 4.5 on Bedrock =
# $1 in / $5 out per MTok (same figures planks 6 and 12 use).

variable "textract_price_per_page" {
  type    = number
  default = 0.05
}

variable "comprehend_price_per_unit" {
  type    = number
  default = 0.0001
}

variable "price_in_per_mtok" {
  type    = number
  default = 1
}

variable "price_out_per_mtok" {
  type    = number
  default = 5
}
