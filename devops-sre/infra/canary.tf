# Synthetic heartbeat over every live plank. Created STOPPED on purpose —
# each run costs ~$0.0012 + Lambda time, so it only runs during demo windows:
#   make canary-start   (before a demo)
#   make canary-stop    (after — also what keeps idle cost ≈ $0)

data "archive_file" "canary" {
  type        = "zip"
  output_path = "${path.module}/build/canary.zip"

  # Synthetics requires this exact folder layout inside the zip.
  source {
    content  = file("${path.module}/../canary/heartbeat.js")
    filename = "nodejs/node_modules/heartbeat.js"
  }
}

resource "aws_s3_bucket" "canary_artifacts" {
  bucket        = "${local.prefix}-canary-artifacts-${local.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "canary_artifacts" {
  bucket                  = aws_s3_bucket.canary_artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "canary_artifacts" {
  bucket = aws_s3_bucket.canary_artifacts.id

  rule {
    id     = "expire-artifacts"
    status = "Enabled"
    filter {}
    expiration {
      days = 30
    }
  }
}

resource "aws_iam_role" "canary" {
  name = "${local.prefix}-canary"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "canary" {
  name = "canary-runtime"
  role = aws_iam_role.canary.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject"]
        Resource = "${aws_s3_bucket.canary_artifacts.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetBucketLocation", "s3:ListAllMyBuckets"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/cwsyn-*"
      },
      {
        Effect   = "Allow"
        Action   = ["cloudwatch:PutMetricData"]
        Resource = "*"
        Condition = {
          StringEquals = { "cloudwatch:namespace" = "CloudWatchSynthetics" }
        }
      },
    ]
  })
}

resource "aws_synthetics_canary" "heartbeat" {
  name                 = "${local.prefix}-heartbeat"
  artifact_s3_location = "s3://${aws_s3_bucket.canary_artifacts.bucket}/heartbeat"
  execution_role_arn   = aws_iam_role.canary.arn
  runtime_version      = "syn-nodejs-puppeteer-16.1"
  handler              = "heartbeat.handler"
  zip_file             = data.archive_file.canary.output_path
  start_canary         = false # demo windows only — see Makefile canary-start/stop

  schedule {
    expression = "rate(5 minutes)"
  }

  run_config {
    timeout_in_seconds = 60
    environment_variables = {
      MONITORED_URLS = join(",", local.monitored_urls)
    }
  }

  success_retention_period = 7
  failure_retention_period = 14
}
