# The account's own record of itself, kept whether or not any plank is up.
#
# Plank 8's detection stack is an exhibit: it exists for a demo window and is
# torn down. This file is not an exhibit. The account is the AWS
# Organization's management account, and until 2026-11-14 the only record of
# who did what in it was CloudTrail's built-in event history: 90 days, one
# region at a time, no integrity proof, nothing an alert could hang off.
#
#   audit trail            every region's management events, hash-chained,
#                          in a bucket nothing but CloudTrail writes to
#   Access Analyzer        names anything reachable from outside the account
#   public access block    account-wide: no bucket here can be made public
#
# All of it is free or costs cents: the first copy of management events is
# free, external-access analysis is free, and a year of logs is a few hundred
# megabytes. The alerts that read from this record are in account-alerts.tf.
#
# Owner-managed, like the CI roles. The pipeline and every role it creates can
# read these and change none of them (local.owner_only in github-oidc.tf), so
# a change here must be applied locally before it is pushed.

locals {
  audit_trail_name = "${local.prefix}-audit-trail"

  # Spelled out because the bucket policy must name the trail before the
  # trail exists (the trail will not start without the policy).
  audit_trail_arn = "arn:aws:cloudtrail:${local.region}:${local.account_id}:trail/${local.audit_trail_name}"
}

# --- where the record lives -----------------------------------------------------

resource "aws_s3_bucket" "audit" {
  bucket = "${local.prefix}-audit-logs-${local.account_id}"

  # No force_destroy. A destroy that reaches this bucket stops at "bucket not
  # empty", which is the right answer for an audit log.
}

resource "aws_s3_bucket_public_access_block" "audit" {
  bucket                  = aws_s3_bucket.audit.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# A deleted or overwritten log file stays recoverable for 30 days. The digest
# chain (enable_log_file_validation below) is what proves a file is missing or
# altered; versioning is what lets it be put back.
resource "aws_s3_bucket_versioning" "audit" {
  bucket = aws_s3_bucket.audit.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id

  rule {
    id     = "keep-one-year"
    status = "Enabled"
    filter {}

    expiration {
      days = 365
    }
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.audit]
}

resource "aws_s3_bucket_policy" "audit" {
  bucket = aws_s3_bucket.audit.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AWSCloudTrailAclCheck"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:GetBucketAcl"
        Resource  = aws_s3_bucket.audit.arn
        Condition = { StringEquals = { "aws:SourceArn" = local.audit_trail_arn } }
      },
      {
        # Only this account's trail, only under this account's prefix.
        Sid       = "AWSCloudTrailWrite"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.audit.arn}/AWSLogs/${local.account_id}/*"
        Condition = {
          StringEquals = {
            "s3:x-amz-acl"  = "bucket-owner-full-control"
            "aws:SourceArn" = local.audit_trail_arn
          }
        }
      },
      {
        Sid       = "TlsOnly"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.audit.arn, "${aws_s3_bucket.audit.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.audit]
}

# --- the trail --------------------------------------------------------------------

# Management events only, reads and writes, every region. No data events and
# no Insights: both bill per event. Plank 8's demo trail (sec-trail) is a
# separate, KMS-encrypted exhibit; while it is up it is this account's second
# copy of management events and bills as one ($2 per 100,000 events, cents per
# demo window).
#
# Both scanners want a customer-managed KMS key here. Log files are SSE-S3
# encrypted; a CMK is $1/mo plus a KMS request on every delivery, the same
# acceptance as the rest of the portfolio (.checkov.yaml, .trivyignore). The
# two skips are scoped to this trail so plank 8's demo trail, which does carry
# a CMK, stays under the gate.
#trivy:ignore:AVD-AWS-0015
resource "aws_cloudtrail" "audit" {
  # checkov:skip=CKV_AWS_35: SSE-S3 instead of a $1/mo CMK; see the comment above this resource
  name                          = local.audit_trail_name
  s3_bucket_name                = aws_s3_bucket.audit.id
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true

  depends_on = [aws_s3_bucket_policy.audit]
}

# --- what is reachable from outside ---------------------------------------------

# Flags every role, bucket, key, queue, topic, function or secret in this
# account that a principal outside it can use. The three CI roles trust
# GitHub's identity provider and are expected to show up; anything else is
# news, and account-alerts.tf mails it.
resource "aws_accessanalyzer_analyzer" "account" {
  analyzer_name = "${local.prefix}-external-access"
  type          = "ACCOUNT"

  # Wire the alarm before switching on the detector: the first scan runs
  # within minutes of creation.
  depends_on = [aws_cloudwatch_event_target.access_finding, aws_sns_topic_policy.alerts]
}

# --- no public buckets, account-wide --------------------------------------------

# Every bucket here already sets all four switches itself. This makes it true
# of buckets that do not exist yet, whoever creates them.
resource "aws_s3_account_public_access_block" "account" {
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
