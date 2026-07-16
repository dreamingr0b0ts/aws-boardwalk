variable "custom_domain_enabled" {
  description = "Attach data.demos.planetek.org + wildcard cert to CloudFront. The zone and cert already exist (created by ../platform), so this defaults on."
  type        = bool
  default     = true
}

variable "site_hostname" {
  description = "Public hostname for this plank"
  type        = string
  default     = "data.demos.planetek.org"
}

variable "zone_name" {
  description = "Shared boardwalk hosted zone (created by ../platform)"
  type        = string
  default     = "demos.planetek.org"
}

# Athena is the only thing here that costs money per request ($5/TB scanned,
# 10 MB minimum per query). Visitors can only run the canned catalog queries,
# every execution is capped by the workgroup's per-query scan cutoff, results
# are cached, and this counter bounds the day. Worst sustained abuse:
# 150 queries x 600 MB x $5/TB ≈ $0.45/day — no credential gate needed.
variable "global_daily_limit" {
  description = "Max live Athena executions across ALL visitors per UTC day (cache hits don't count)"
  type        = number
  default     = 150
}

variable "bytes_scanned_cutoff" {
  description = "Athena workgroup per-query scan cutoff in bytes. Must clear a full raw-zone scan (~350 MB) — the deliberately inefficient half of the raw-vs-curated demo."
  type        = number
  default     = 629145600 # 600 MB
}

variable "query_cache_ttl_hours" {
  description = "How long a live query result is served from the DynamoDB cache before Athena runs again"
  type        = number
  default     = 6
}
