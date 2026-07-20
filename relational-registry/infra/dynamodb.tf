# Single-table usage ledger:
#   USAGE#<yyyy-mm-dd> / GLOBAL    atomic counter — global daily cap on exhibit
#                                  executions (bounds how long visitors can keep
#                                  the cluster awake); TTL expires old rows.

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
