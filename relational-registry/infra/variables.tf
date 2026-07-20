variable "custom_domain_enabled" {
  description = "Attach registry.demos.planetek.org + the wildcard cert. Default MUST match live state — CI applies with defaults only."
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
  default     = "registry.demos.planetek.org"
}

variable "global_daily_limit" {
  description = "Max exhibit executions across ALL visitors per UTC day. Queries are free per-request; this bounds how long strangers can keep the cluster awake (worst case ≈ 24h × 1 ACU ≈ $3/day, only while the demo stack is deployed at all)."
  type        = number
  default     = 400
}
