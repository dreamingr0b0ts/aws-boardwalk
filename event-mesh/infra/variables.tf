variable "custom_domain_enabled" {
  description = "Attach events.demos.planetek.org + wildcard cert to CloudFront. The zone and cert already exist (created by ../platform), so this defaults on."
  type        = bool
  default     = true
}

variable "site_hostname" {
  description = "Public hostname for this plank"
  type        = string
  default     = "events.demos.planetek.org"
}

variable "zone_name" {
  description = "Shared boardwalk hosted zone (created by ../platform)"
  type        = string
  default     = "demos.planetek.org"
}

# Unlike planks 6 and 7 there is no credential gate here: every service in the
# mesh (EventBridge, SQS, SNS, Express Step Functions, Lambda, DynamoDB) is
# free-tier or fractions of a cent per million, so the plank is public by
# design like plank 1. The cap below is an abuse bound, not a cost bound.
variable "global_daily_limit" {
  description = "Max accepted service requests across ALL visitors per UTC day"
  type        = number
  default     = 1000
}

variable "pattern_daily_limit" {
  description = "Max interlocking-tester (TestEventPattern) runs across ALL visitors per UTC day. The API call is free; this is a nuisance bound."
  type        = number
  default     = 500
}

variable "race_daily_limit" {
  description = "Max block-order races across ALL visitors per UTC day (each race is ~21 SQS sends + ~20 Lambda invokes, all free-tier)"
  type        = number
  default     = 100
}

variable "replay_daily_limit" {
  description = "Max archive replays across ALL visitors per UTC day (one at a time; each replays at most the capped daily traffic)"
  type        = number
  default     = 10
}

variable "heartbeat_rate" {
  description = "EventBridge Scheduler rate for the synthetic heartbeat request that keeps the live dashboard populated between visitors"
  type        = string
  default     = "rate(30 minutes)"
}
