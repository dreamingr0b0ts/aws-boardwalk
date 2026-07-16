# Single-table design:
#   REQ#<id>  / META                 request record: category, priority, status
#   REQ#<id>  / HOP#<iso-ts>#<name>  one trace item per hop through the mesh —
#                                    the raw material for the live dashboard
#   STATS     / TOTALS               lifetime atomic counters (events,
#                                    notifications, retries, dead letters, …)
#   USAGE#<yyyy-mm-dd> / GLOBAL      atomic counter — global daily abuse cap
# Requests and hops carry a 48h TTL; heartbeats keep fresh ones flowing, and
# the nightly reset sweeps whatever TTL hasn't reached yet.

resource "aws_dynamodb_table" "events" {
  name         = "${local.prefix}-events"
  billing_mode = "PAY_PER_REQUEST"

  hash_key  = "PK"
  range_key = "SK"

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }
}
