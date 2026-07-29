# Single-table design:
#   DOC#<docId>        / META           document record: status, pipeline step
#                                       timeline, OCR/KV/entity/classification
#                                       metadata — the searchable index
#   USAGE#<yyyy-mm-dd> / GLOBAL         atomic counter — global daily kill switch
#   USAGE#<yyyy-mm-dd> / USER#<sub>     atomic counter — per-user daily cap
#   USAGE#<yyyy-mm-dd> / ANON#<iphash>  atomic counter — per-visitor daily cap
#   USAGE#<yyyy-mm-dd> / ANON-GLOBAL    atomic counter — anonymous daily pool
# Uploaded documents carry a TTL as the backstop behind the nightly reset
# (72h credentialed, 24h anonymous); seeds have no TTL and form the permanent
# browsable corpus. Anonymous documents never appear in the public index.

resource "aws_dynamodb_table" "documents" {
  name         = "${local.prefix}-documents"
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
