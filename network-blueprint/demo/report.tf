# The paths-to-evidence Lambda: reads the live network (subnets, routing,
# SG tiers, NACLs, endpoints, flow logs), replays the connectivity probe
# suite on both instances via SSM Run Command, joins the Reachability
# Analyzer verdicts, and writes evidence.json + a standalone evidence.html
# into the ALWAYS-ON site bucket. The report is the artifact that survives
# teardown.

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
  name = "network-evidence-report"
  role = aws_iam_role.report.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DescribeNetwork"
        Effect = "Allow"
        Action = [
          "ec2:DescribeVpcs",
          "ec2:DescribeSubnets",
          "ec2:DescribeRouteTables",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeNetworkAcls",
          "ec2:DescribeVpcEndpoints",
          "ec2:DescribeFlowLogs",
          "ec2:DescribeInstances",
          "ec2:DescribeNatGateways",
          "ec2:DescribeNetworkInsightsAnalyses",
          "ec2:DescribeNetworkInsightsPaths",
        ]
        Resource = "*" # EC2 Describe* calls support no resource-level scoping
      },
      {
        Sid    = "RunProbes"
        Effect = "Allow"
        Action = "ssm:SendCommand"
        Resource = [
          "arn:aws:ssm:${local.region}::document/AWS-RunShellScript",
          "arn:aws:ec2:${local.region}:${local.account_id}:instance/${aws_instance.public_web.id}",
          "arn:aws:ec2:${local.region}:${local.account_id}:instance/${aws_instance.private_app.id}",
        ]
      },
      {
        Sid      = "ReadProbeResults"
        Effect   = "Allow"
        Action   = "ssm:GetCommandInvocation"
        Resource = "*" # command ids aren't known until runtime
      },
      {
        Sid      = "ReadFlowLogs"
        Effect   = "Allow"
        Action   = "logs:FilterLogEvents"
        Resource = "${aws_cloudwatch_log_group.flow.arn}:*"
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
  timeout          = 300 # SSM probe suites run ~30-60s per instance
  memory_size      = 256

  environment {
    variables = {
      SITE_BUCKET         = data.terraform_remote_state.infra.outputs.site_bucket
      SITE_BUCKET_ARN     = data.terraform_remote_state.infra.outputs.site_bucket_arn
      VPC_ID              = aws_vpc.lab.id
      PUBLIC_INSTANCE_ID  = aws_instance.public_web.id
      PRIVATE_INSTANCE_ID = aws_instance.private_app.id
      PRIVATE_APP_IP      = aws_instance.private_app.private_ip
      FLOW_LOG_GROUP      = aws_cloudwatch_log_group.flow.name
      TIER_SGS = jsonencode({
        web  = aws_security_group.web.id
        app  = aws_security_group.app.id
        data = aws_security_group.data.id
        vpce = aws_security_group.vpce.id
      })
      ANALYSES = jsonencode([
        for key, path in local.insights_paths : {
          key     = key
          id      = aws_ec2_network_insights_analysis.analysis[key].id
          expect  = path.expect
          label   = path.label
          because = path.because
          port    = path.port
        }
      ])
    }
  }

  tracing_config {
    mode = "Active"
  }
}

output "report_function" {
  value = aws_lambda_function.report.function_name
}

output "vpc_id" {
  value = aws_vpc.lab.id
}

output "public_instance_id" {
  value = aws_instance.public_web.id
}

output "private_instance_id" {
  value = aws_instance.private_app.id
}

output "flow_log_group" {
  value = aws_cloudwatch_log_group.flow.name
}

output "analysis_ids" {
  value = { for k, a in aws_ec2_network_insights_analysis.analysis : k => a.id }
}
