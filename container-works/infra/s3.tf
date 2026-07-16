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

# Report artifacts written by the container (task role can put ONLY under
# artifacts/) expire on the same 48h clock as the DynamoDB run records —
# S3 lifecycle does the cleanup, no reset Lambda needed on this plank.
resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.site.id

  rule {
    id     = "expire-run-artifacts"
    status = "Enabled"

    filter {
      prefix = "artifacts/"
    }

    expiration {
      days = 2
    }
  }
}
