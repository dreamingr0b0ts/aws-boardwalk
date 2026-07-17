# The findings-to-evidence Lambda: reads every exhibit's live state
# (CloudTrail status, KMS rotation, GuardDuty findings, Security Hub controls,
# conformance pack compliance, boundary simulation) and writes evidence.json +
# a standalone evidence.html into the ALWAYS-ON site bucket. The report is the
# artifact that survives teardown.

data "archive_file" "report" {
  type        = "zip"
  source_file = "${path.module}/lambda/report.mjs"
  output_path = "${path.module}/lambda/report.zip"
}

resource "aws_iam_role" "report" {
  name = "${local.prefix}-report-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "report" {
  name = "evidence-report"
  role = aws_iam_role.report.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadCloudTrail"
        Effect   = "Allow"
        Action   = ["cloudtrail:DescribeTrails", "cloudtrail:GetTrailStatus"]
        Resource = "*" # DescribeTrails supports no resource ARN; GetTrailStatus is account-scoped read-only
      },
      {
        Sid      = "ReadKms"
        Effect   = "Allow"
        Action   = ["kms:DescribeKey", "kms:GetKeyRotationStatus"]
        Resource = aws_kms_key.trail.arn
      },
      {
        Sid      = "ReadGuardDuty"
        Effect   = "Allow"
        Action   = ["guardduty:ListDetectors", "guardduty:ListFindings", "guardduty:GetFindingsStatistics"]
        Resource = "*" # read-only; detector id isn't known until apply and ListDetectors takes no ARN
      },
      {
        Sid      = "ReadSecurityHub"
        Effect   = "Allow"
        Action   = ["securityhub:GetFindings", "securityhub:GetEnabledStandards"]
        Resource = "*" # read-only aggregation over the hub
      },
      {
        Sid    = "ReadConfig"
        Effect = "Allow"
        Action = [
          "config:DescribeConfigurationRecorderStatus",
          "config:GetConformancePackComplianceSummary",
          "config:DescribeConformancePackCompliance",
        ]
        Resource = "*" # read-only compliance summaries
      },
      {
        Sid      = "SimulateBoundaryRole"
        Effect   = "Allow"
        Action   = ["iam:SimulatePrincipalPolicy", "iam:GetRole"]
        Resource = aws_iam_role.boundary_demo.arn
      },
      {
        Sid      = "WriteEvidence"
        Effect   = "Allow"
        Action   = "s3:PutObject"
        Resource = "${data.terraform_remote_state.infra.outputs.site_bucket_arn}/evidence/*"
      },
      {
        Sid      = "OwnLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/${local.prefix}-evidence-report*"
      },
      {
        Sid      = "XRay"
        Effect   = "Allow"
        Action   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
        Resource = "*" # X-Ray supports no resource-level scoping for these
      }
    ]
  })
}

resource "aws_lambda_function" "report" {
  function_name    = "${local.prefix}-evidence-report"
  role             = aws_iam_role.report.arn
  runtime          = "nodejs22.x"
  handler          = "report.handler"
  architectures    = ["arm64"]
  filename         = data.archive_file.report.output_path
  source_code_hash = data.archive_file.report.output_base64sha256
  timeout          = 120
  memory_size      = 256

  environment {
    variables = {
      SITE_BUCKET       = data.terraform_remote_state.infra.outputs.site_bucket
      DETECTOR_ID       = aws_guardduty_detector.main.id
      TRAIL_NAME        = aws_cloudtrail.main.name
      KMS_KEY_ID        = aws_kms_key.trail.key_id
      CONFORMANCE_PACK  = aws_config_conformance_pack.nist.name
      BOUNDARY_ROLE_ARN = aws_iam_role.boundary_demo.arn
      SITE_BUCKET_ARN   = data.terraform_remote_state.infra.outputs.site_bucket_arn
    }
  }

  tracing_config {
    mode = "Active"
  }
}

output "report_function" {
  value = aws_lambda_function.report.function_name
}

output "detector_id" {
  value = aws_guardduty_detector.main.id
}

output "trail_name" {
  value = aws_cloudtrail.main.name
}

output "conformance_pack" {
  value = aws_config_conformance_pack.nist.name
}

output "boundary_role" {
  value = aws_iam_role.boundary_demo.name
}
