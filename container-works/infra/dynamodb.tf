# Single-table design:
#   RUN#<taskId> / META                 one record per container run: job, source,
#                                       lifecycle timestamps, exit code, artifact
#   LIST         / RUN#<iso-ts>#<id>    pointer items so "recent runs" is one Query
#   USAGE#<yyyy-mm-dd> / GLOBAL         atomic counter — the global daily launch cap
# Runs carry a 48h TTL; the daily scheduled run keeps the feed from ever being
# empty, and S3 lifecycle expires the report artifacts on the same clock.

resource "aws_dynamodb_table" "runs" {
  name         = "${local.prefix}-runs"
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
