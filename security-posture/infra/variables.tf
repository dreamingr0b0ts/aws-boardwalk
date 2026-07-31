variable "custom_domain_enabled" {
  description = "Attach security.demos.planetek.org + the wildcard cert. Default MUST match live state — CI applies with defaults only."
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
  default     = "security.demos.planetek.org"
}

variable "drill_daily_limit" {
  description = "Global practice-smoke drills per UTC day across all visitors"
  type        = number
  default     = 10
}

variable "policy_daily_limit" {
  description = "Global policy-desk calls (simulate + validate) per UTC day"
  type        = number
  default     = 500
}
