# Single-table design:
#   CATALOG / TYPE#<slug>          permit types
#   APP#<id> / META                application record
#   APP#<id> / EVENT#<ts>          status-history events
#   STATS / CURRENT                materialized live counters
#   STATS / MONTH#YYYY-MM          monthly aggregates for dashboards
# GSI1: applications by user (USER#<sub> / submittedAt)
# GSI2: applications by status (STATUS#<status> / submittedAt) — the admin queue

resource "aws_dynamodb_table" "permits" {
  name         = "${local.prefix}-permits"
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
  attribute {
    name = "GSI1PK"
    type = "S"
  }
  attribute {
    name = "GSI1SK"
    type = "S"
  }
  attribute {
    name = "GSI2PK"
    type = "S"
  }
  attribute {
    name = "GSI2SK"
    type = "S"
  }

  global_secondary_index {
    name            = "GSI1"
    hash_key        = "GSI1PK"
    range_key       = "GSI1SK"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "GSI2"
    hash_key        = "GSI2PK"
    range_key       = "GSI2SK"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }
}
