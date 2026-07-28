# Single-table design for visitor-triggered inspection rounds:
#   RUN#<insp-id> / META            one record per round: status, probe rows,
#                                   plan-check verdicts, the field-book log
#   LIST          / RUN#<iso>#<id>  pointer items so "recent rounds" is one Query
#   USAGE#<yyyy-mm-dd> / GLOBAL     atomic counter — the global daily round cap
#   LOCK / GLOBAL                   one-inspector-at-a-time gate; extra POSTs
#                                   get a 409 pointing at the round under way
# Rounds carry a 48h TTL, mirroring the containers plank's run records.

resource "aws_dynamodb_table" "inspections" {
  name         = "${local.prefix}-inspections"
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
