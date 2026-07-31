# Two plain-ESM Lambdas, no build step: every AWS SDK v3 client they need
# ships inside the nodejs22 runtime. The api function gates, reads, and runs
# the free always-on exhibits (policy desk, fence log); the runner walks a
# practice-smoke drill end to end so the page can watch it move.

data "archive_file" "api" {
  type        = "zip"
  source_file = "${path.module}/lambda/api.mjs"
  output_path = "${path.module}/lambda/api.zip"
}

data "archive_file" "runner" {
  type        = "zip"
  source_file = "${path.module}/lambda/runner.mjs"
  output_path = "${path.module}/lambda/runner.zip"
}

resource "aws_lambda_function" "api" {
  function_name    = "${local.prefix}-exhibit-api"
  role             = aws_iam_role.api.arn
  runtime          = "nodejs22.x"
  handler          = "api.handler"
  architectures    = ["arm64"]
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  memory_size      = 256
  timeout          = 20

  environment {
    variables = {
      TABLE_NAME         = aws_dynamodb_table.exhibits.name
      SSM_PREFIX         = local.ssm_prefix
      RUNNER_FUNCTION    = aws_lambda_function.runner.function_name
      DRILL_DAILY_LIMIT  = tostring(var.drill_daily_limit)
      POLICY_DAILY_LIMIT = tostring(var.policy_daily_limit)
      BOUNDARY_ROLE_ARN  = aws_iam_role.boundary_demo.arn
      SITE_BUCKET_ARN    = aws_s3_bucket.site.arn
      WAF_ACL_ARN        = data.aws_wafv2_web_acl.edge.arn
      # metric = each rule's visibility_config metric_name in ../platform/waf.tf
      WAF_RULES = jsonencode([
        { metric = "platform-edge-rate-limit", label = "Rate limit: 300 requests per 5 minutes per IP" },
        { metric = "platform-edge-ip-reputation", label = "Amazon IP reputation list" },
        { metric = "platform-edge-known-bad-inputs", label = "Known bad inputs (incl. Log4j probes)" },
      ])
    }
  }

  tracing_config {
    mode = "Active"
  }
}

resource "aws_lambda_function" "runner" {
  function_name    = "${local.prefix}-drill-runner"
  role             = aws_iam_role.runner.arn
  runtime          = "nodejs22.x"
  handler          = "runner.handler"
  architectures    = ["arm64"]
  filename         = data.archive_file.runner.output_path
  source_code_hash = data.archive_file.runner.output_base64sha256
  memory_size      = 256
  timeout          = 540 # stage + tripwire wait + 75s burn + Config diary poll

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.exhibits.name
      SSM_PREFIX = local.ssm_prefix
    }
  }

  tracing_config {
    mode = "Active"
  }
}
