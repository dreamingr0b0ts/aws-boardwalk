# Single-table usage ledger + seal watch:
#   USAGE#<yyyy-mm-dd> / GLOBAL    atomic counter — global daily cap on exhibit
#                                  executions (bounds how long visitors can keep
#                                  the cluster awake); TTL expires old rows.
#   USAGE#<yyyy-mm-dd> / IP#<h16>  per-hashed-IP counter for the title search
#                                  desk (the plank's only visitor-typed input).
#   SEAL / TOUCH                   last Data API touch — drives the page's
#                                  countdown to auto-pause.
#   SEAL / WAKE-PENDING            resume-in-progress marker (first 202 stamps it).
#   WAKE#LOG / <iso>               measured unsealings, 30-day TTL; survives
#                                  teardown so past wakes stay on the record.

resource "aws_dynamodb_table" "registry" {
  name         = "${local.prefix}-registry"
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
