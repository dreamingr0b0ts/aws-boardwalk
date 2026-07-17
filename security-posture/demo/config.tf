# Exhibit 5 — AWS Config recording every supported resource type, evaluated
# against the AWS-published "Operational Best Practices for NIST 800-53 rev 5"
# conformance pack (130 managed rules, vendored in templates/ — Apache-2.0,
# from awslabs/aws-config-rules). This is the daily-billing heart of the
# plank and the reason it tears down: Config bills per configuration item
# recorded and per rule evaluation.

resource "aws_iam_service_linked_role" "config" {
  aws_service_name = "config.amazonaws.com"
}

resource "aws_s3_bucket" "config" {
  bucket        = "${local.prefix}-config-${local.account_id}"
  force_destroy = true # demo window snapshots; make teardown must work
}

resource "aws_s3_bucket_public_access_block" "config" {
  bucket = aws_s3_bucket.config.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "config" {
  bucket = aws_s3_bucket.config.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AWSConfigBucketPermissionsCheck"
        Effect    = "Allow"
        Principal = { Service = "config.amazonaws.com" }
        Action    = ["s3:GetBucketAcl", "s3:ListBucket"]
        Resource  = aws_s3_bucket.config.arn
        Condition = {
          StringEquals = { "AWS:SourceAccount" = local.account_id }
        }
      },
      {
        Sid       = "AWSConfigBucketDelivery"
        Effect    = "Allow"
        Principal = { Service = "config.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.config.arn}/AWSLogs/${local.account_id}/Config/*"
        Condition = {
          StringEquals = {
            "s3:x-amz-acl"      = "bucket-owner-full-control"
            "AWS:SourceAccount" = local.account_id
          }
        }
      }
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.config]
}

resource "aws_config_configuration_recorder" "main" {
  name     = "${local.prefix}-recorder"
  role_arn = aws_iam_service_linked_role.config.arn

  recording_group {
    all_supported                 = true
    include_global_resource_types = true
  }
}

resource "aws_config_delivery_channel" "main" {
  name           = "${local.prefix}-delivery"
  s3_bucket_name = aws_s3_bucket.config.id

  depends_on = [aws_config_configuration_recorder.main, aws_s3_bucket_policy.config]
}

resource "aws_config_configuration_recorder_status" "main" {
  name       = aws_config_configuration_recorder.main.name
  is_enabled = true

  depends_on = [aws_config_delivery_channel.main]
}

# The pack template is far too big for template_body's 51,200-byte ceiling to
# stay comfortable, so it ships to S3 first and deploys by reference.
resource "aws_s3_object" "nist_template" {
  bucket = aws_s3_bucket.config.id
  key    = "conformance-packs/nist-800-53-rev5.yaml"
  source = "${path.module}/templates/nist-800-53-rev5.yaml"
  etag   = filemd5("${path.module}/templates/nist-800-53-rev5.yaml")
}

resource "aws_config_conformance_pack" "nist" {
  name            = "${local.prefix}-nist-800-53-rev5"
  template_s3_uri = "s3://${aws_s3_object.nist_template.bucket}/${aws_s3_object.nist_template.key}"

  depends_on = [aws_config_configuration_recorder_status.main]
}
