variable "custom_domain_enabled" {
  description = "Attach api.demos.planetek.org + wildcard cert to CloudFront. The zone and cert already exist (created by ../platform), so this defaults on."
  type        = bool
  default     = true
}

variable "site_hostname" {
  description = "Public hostname for this plank"
  type        = string
  default     = "api.demos.planetek.org"
}

variable "zone_name" {
  description = "Shared boardwalk hosted zone (created by ../platform)"
  type        = string
  default     = "demos.planetek.org"
}

# Everything behind this API is free-tier reads plus TTL'd DynamoDB writes, so
# like plank 3 it is public by design — the demo key is printed on the docs
# page. The usage plans below are the governance exhibit itself: they bound
# nuisance, not spend.
variable "demo_quota_per_day" {
  description = "Daily request quota on the shared demo API key"
  type        = number
  default     = 2500
}

# Deliberately tight: the key is shared by every visitor, and API Gateway's
# distributed token buckets are best-effort (small limits under-enforce —
# a 40-parallel burst sailed through 5 rps/burst 10 without a single 429).
# 2/5 keeps try-it browsing comfortable while making the throttle exhibit
# actually demonstrable.
variable "demo_rate_limit" {
  description = "Steady-state requests/second on the demo usage plan"
  type        = number
  default     = 2
}

variable "demo_burst_limit" {
  description = "Burst bucket on the demo usage plan"
  type        = number
  default     = 5
}

# --- self-service visitor keys (POST /v2/platform/keys) ----------------------
# Worst case: visitor_keys_per_day × visitor_quota_per_day = 12,500 req/day,
# all free-tier Lambda + DynamoDB reads — the caps bound nuisance, not spend.

variable "visitor_quota_per_day" {
  description = "Daily request quota on each self-issued visitor key"
  type        = number
  default     = 500
}

variable "visitor_keys_per_ip_per_day" {
  description = "Personal keys one address may mint per day (verify.sh consumes one per run)"
  type        = number
  default     = 5
}

variable "visitor_keys_per_day" {
  description = "Exchange-wide cap on personal keys minted per day"
  type        = number
  default     = 25
}

# --- async exports (POST /v2/exports) ----------------------------------------
variable "exports_per_day" {
  description = "Exchange-wide cap on export jobs per day (each is one small table scan + one small S3 object)"
  type        = number
  default     = 200
}
