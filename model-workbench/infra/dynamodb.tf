# Single-table design:
#   USAGE#<yyyy-mm-dd> / GLOBAL        atomic counter — global daily kill switch
#   USAGE#<yyyy-mm-dd> / USER#<sub>    atomic counter — per-user daily cap
#   RUN#<yyyy-mm-dd>   / <ts>#<id>     the audit ledger: every run's models,
#                                      parameters, token counts, computed cost,
#                                      and latency — TTL 30 days
# TTL means no reset job: counters and ledger rows expire on their own, and
# with self-signup disabled there are no stranger accounts to purge.

resource "aws_dynamodb_table" "workbench" {
  name         = "${local.prefix}-workbench"
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
