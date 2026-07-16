# --- static site bucket (same OAC pattern as every plank) ---------------------

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

# --- the lake ------------------------------------------------------------------
# raw/       source records exactly as delivered (JSONL, gzipped)
# curated/   partitioned Parquet written by the Athena CTAS ETL
# analytics/ dashboard aggregates the ETL precomputes (JSON, read by /api/summary)
# athena-results/ workgroup query output — ephemeral, expired by lifecycle

resource "aws_s3_bucket" "lake" {
  bucket        = "${local.prefix}-lake-${local.account_id}"
  force_destroy = true # demo environment; make seed rebuilds the lake from source
}

resource "aws_s3_bucket_public_access_block" "lake" {
  bucket = aws_s3_bucket.lake.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "lake" {
  bucket = aws_s3_bucket.lake.id

  # Query results only exist so Athena has somewhere to write; the API reads
  # them once and the cache takes over.
  rule {
    id     = "expire-athena-results"
    status = "Enabled"
    filter {
      prefix = "${local.results_prefix}/"
    }
    expiration {
      days = 7
    }
  }

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}
