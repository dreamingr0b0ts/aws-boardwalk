variable "custom_domain_enabled" {
  description = "Attach network.demos.planetek.org + the wildcard cert. Default MUST match live state — CI applies with defaults only."
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
  default     = "network.demos.planetek.org"
}

# A probe round is free (SSM Run Command + a few DynamoDB writes), so like the
# containers plank this cap bounds nuisance, not spend. One round runs at a
# time; extra trigger attempts get a 409 pointing at the round under way.
variable "global_daily_limit" {
  description = "Max inspection rounds across ALL visitors per UTC day"
  type        = number
  default     = 30
}
