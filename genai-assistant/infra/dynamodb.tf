# Single-table design:
#   USAGE#<yyyy-mm-dd> / GLOBAL        atomic counter — global daily kill switch
#   USAGE#<yyyy-mm-dd> / USER#<sub>    atomic counter — per-user daily cap
#   CONV#<sub>         / <ts>#<id>     conversation log (audit trail), TTL 7 days
#   FEEDBACK           / <ts>#<sub>    human-feedback loop, TTL 90 days
# TTL replaces plank 1's nightly reset job: usage counters and logs expire on
# their own, and with self-signup disabled there are no stranger accounts to purge.

resource "aws_dynamodb_table" "assistant" {
  name         = "${local.prefix}-assistant"
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
