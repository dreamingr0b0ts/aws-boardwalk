# Daily submission counters (per-IP + global) so a leaked/abused form can't
# turn SES into a spam cannon. Items TTL out after two days.
resource "aws_dynamodb_table" "rate_limit" {
  name         = "${local.prefix}-rate-limit"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
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
