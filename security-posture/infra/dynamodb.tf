# Single-table design for the visitor exhibits:
#   RUN#<smk-id>  / META            one record per practice-smoke drill: status,
#                                   stage map, the field log
#   LIST          / RUN#<iso>#<id>  pointer items so "recent drills" is one Query
#   USAGE#<date>  / GLOBAL          atomic counters — drills and policy-desk
#                                   calls share the day item as separate attrs
#   LOCK / GLOBAL                   one-drill-at-a-time gate; extra POSTs get a
#                                   409 pointing at the drill under way
# Drill records carry a 48h TTL, mirroring planks 4 and 9.

resource "aws_dynamodb_table" "exhibits" {
  name         = "${local.prefix}-exhibits"
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
