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
