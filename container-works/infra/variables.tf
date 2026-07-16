variable "custom_domain_enabled" {
  description = "Attach containers.demos.planetek.org + wildcard cert to CloudFront. The zone and cert already exist (created by ../platform), so this defaults on."
  type        = bool
  default     = true
}

variable "site_hostname" {
  description = "Public hostname for this plank"
  type        = string
  default     = "containers.demos.planetek.org"
}

variable "zone_name" {
  description = "Shared boardwalk hosted zone (created by ../platform)"
  type        = string
  default     = "demos.planetek.org"
}

# Like plank 3 this is public with no credential gate, but here a request DOES
# cost real (tiny) money: one Fargate run-task is ~$0.001 of compute + public
# IP time. The caps below make the worst case pocket change: 30 runs/day of a
# ~1-minute 0.25 vCPU task ≈ $0.02/day even if every slot is burned.
variable "global_daily_limit" {
  description = "Max container launches across ALL visitors per UTC day"
  type        = number
  default     = 30
}

variable "max_concurrent_tasks" {
  description = "Max Fargate tasks in flight at once; extra launch requests get a 409 pointing at the in-flight run so visitors share the live view"
  type        = number
  default     = 1
}

variable "scheduled_report" {
  description = "Cron for the daily scheduled run (the 'or scheduled' half of run-task; also keeps the recent-runs feed alive between visitors)"
  type        = string
  default     = "cron(0 13 * * ? *)" # 13:00 UTC = 6/7am MT
}
