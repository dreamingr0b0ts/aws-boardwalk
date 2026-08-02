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

# Consultation bookings, one item per taken slot (pk "booking", sk = ISO-UTC
# start time). The conditional write on sk is the whole double-booking story.
# Availability itself is computed in the Lambda, never stored. Items TTL out
# a week after the meeting.
resource "aws_dynamodb_table" "bookings" {
  name         = "${local.prefix}-bookings"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
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
