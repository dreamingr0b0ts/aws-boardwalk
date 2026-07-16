# Single-table design:
#   CACHE#<queryId> / RESULT   cached live-query result + Athena stats (TTL'd,
#                              so a popular query hits Athena once per window)
#   USAGE#<yyyy-mm-dd> / GLOBAL atomic counter — the daily Athena-execution cap

resource "aws_dynamodb_table" "app" {
  name         = "${local.prefix}-app"
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
