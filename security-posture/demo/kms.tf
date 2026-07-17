# Exhibit 1 — customer-managed KMS key with automatic rotation, used to
# encrypt the CloudTrail audit log bucket. The key policy is the exhibit:
# CloudTrail may only GenerateDataKey for THIS account's trail (SourceArn
# condition), and nothing else gets grants. Torn down with the stack —
# a key pending deletion (7-day window) bills nothing.

resource "aws_kms_key" "trail" {
  description             = "Alpenglow security demo: CloudTrail log encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 7

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountRootFullAccess"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${local.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "CloudTrailEncrypt"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "kms:GenerateDataKey*"
        Resource  = "*"
        Condition = {
          StringEquals = {
            "aws:SourceArn" = "arn:aws:cloudtrail:${local.region}:${local.account_id}:trail/${local.prefix}-trail"
          }
          StringLike = {
            "kms:EncryptionContext:aws:cloudtrail:arn" = "arn:aws:cloudtrail:*:${local.account_id}:trail/*"
          }
        }
      },
      {
        Sid       = "CloudTrailDescribe"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "kms:DescribeKey"
        Resource  = "*"
      }
    ]
  })
}

resource "aws_kms_alias" "trail" {
  name          = "alias/${local.prefix}-trail"
  target_key_id = aws_kms_key.trail.key_id
}
