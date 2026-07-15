resource "aws_s3_bucket" "site" {
  bucket        = "${local.prefix}-site-${local.account_id}"
  force_destroy = true # demo environment; make destroy must work
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket = aws_s3_bucket.site.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Only CloudFront (via Origin Access Control) can read; the bucket has no
# public surface at all.
resource "aws_s3_bucket_policy" "site_oac" {
  bucket = aws_s3_bucket.site.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontOAC"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.site.arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.site.arn
        }
      }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.site]
}

# Documents bucket: originals under incoming/<docId>/, full Textract
# extractions under extracted/<docId>.json. Uploads land here directly via
# presigned POST; every ObjectCreated under incoming/ starts a pipeline run.
resource "aws_s3_bucket" "docs" {
  bucket        = "${local.prefix}-docs-${local.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "docs" {
  bucket = aws_s3_bucket.docs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# The browser talks to this bucket exactly once per document: the presigned
# POST. Reads of originals go through short-lived presigned GET links (plain
# navigation, no CORS needed).
resource "aws_s3_bucket_cors_configuration" "docs" {
  bucket = aws_s3_bucket.docs.id

  cors_rule {
    allowed_origins = ["https://${var.site_hostname}"]
    allowed_methods = ["POST"]
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "docs" {
  bucket = aws_s3_bucket.docs.id

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# Route S3 object events onto the default EventBridge bus, where a rule
# (events.tf) forwards incoming/* creations to the Step Functions pipeline.
resource "aws_s3_bucket_notification" "docs" {
  bucket      = aws_s3_bucket.docs.id
  eventbridge = true
}
