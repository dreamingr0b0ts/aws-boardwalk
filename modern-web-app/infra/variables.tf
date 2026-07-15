variable "custom_domain_enabled" {
  description = "Attach permits.demos.planetek.org + wildcard cert to CloudFront. Flip to true only after the GoDaddy NS delegation is live and the ACM cert shows ISSUED."
  type        = bool
  default     = false
}

variable "site_hostname" {
  description = "Public hostname for this plank"
  type        = string
  default     = "permits.demos.planetek.org"
}

variable "zone_name" {
  description = "Shared boardwalk hosted zone (created by ../platform)"
  type        = string
  default     = "demos.planetek.org"
}

# Demo credentials are intentionally public — they're printed on the login
# screen so proposal reviewers can walk straight in. The nightly reset Lambda
# re-asserts them and removes every other user.
variable "demo_admin_email" {
  type    = string
  default = "admin@demo.planetek.org"
}

variable "demo_admin_password" {
  type    = string
  default = "Alpenglow-Admin1!"
}

variable "demo_citizen_email" {
  type    = string
  default = "citizen@demo.planetek.org"
}

variable "demo_citizen_password" {
  type    = string
  default = "Alpenglow-Citizen1!"
}
