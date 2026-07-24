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

# ---------------------------------------------------------------------------
# Citizen document uploads. Browsers upload straight to S3 with a presigned
# POST minted by the me Lambda (4 MB cap and content-type enforced in the
# POST policy), so file bytes never transit Lambda or API Gateway. The bucket
# is fully private: downloads are short-lived presigned GETs for the owner
# and reviewing staff only.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "uploads" {
  bucket        = "${local.prefix}-uploads-${local.account_id}"
  force_destroy = true # demo environment; make destroy must work
}

resource "aws_s3_bucket_public_access_block" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Demo hygiene: objects live at most a day past the nightly reset that
# deletes their records; nothing accumulates.
resource "aws_s3_bucket_lifecycle_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  rule {
    id     = "expire-demo-uploads"
    status = "Enabled"
    filter {}
    expiration {
      days = 1
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# The presigned POST is a cross-origin call from the site to S3; downloads
# are top-level navigations to presigned GETs and need no CORS.
resource "aws_s3_bucket_cors_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  cors_rule {
    allowed_origins = concat(
      ["https://${aws_cloudfront_distribution.site.domain_name}"],
      var.custom_domain_enabled ? ["https://${var.site_hostname}"] : []
    )
    allowed_methods = ["POST"]
    allowed_headers = ["*"]
    max_age_seconds = 3600
  }
}
