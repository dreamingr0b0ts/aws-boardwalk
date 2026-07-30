# One table per microservice — the service boundary is real: each Lambda's
# role can only reach its own table (see iam.tf).
#
# apx-permits is single-table within its service:
#   PK=<permitId> / SK=META        the permit record
#   PK=<permitId> / SK=INS#<id>    visitor-requested inspections (ttl = 24h,
#                                  so stranger writes self-clean; the seed
#                                  catalog has no ttl and persists)

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

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }
}

resource "aws_dynamodb_table" "licenses" {
  name         = "${local.prefix}-licenses"
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "id"

  attribute {
    name = "id"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}

resource "aws_dynamodb_table" "facilities" {
  name         = "${local.prefix}-facilities"
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "id"

  attribute {
    name = "id"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}

# Platform service: issuance counters (CNT#<date> / IP#… | GLOBAL) and visitor
# key audit records (KEY#<id> / META). Everything carries a ttl — the table's
# steady state is near-empty.
resource "aws_dynamodb_table" "platform" {
  name         = "${local.prefix}-platform"
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

# Exports service: job records (EXP-…) plus the daily counter row (CNT#<date>,
# unreadable through the API by id-prefix guard). All rows TTL out in ≤48h.
resource "aws_dynamodb_table" "exports" {
  name         = "${local.prefix}-exports"
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "id"

  attribute {
    name = "id"
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
