# Two plain-ESM Lambdas, no build step: every AWS SDK v3 client they need
# ships inside the nodejs22 runtime. The api function gates and reads; the
# runner walks the site one SSM probe at a time so the page can watch the
# round move.

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
  function_name    = "${local.prefix}-inspection-api"
  role             = aws_iam_role.api.arn
  runtime          = "nodejs22.x"
  handler          = "api.handler"
  architectures    = ["arm64"]
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  memory_size      = 256
  timeout          = 15

  environment {
    variables = {
      TABLE_NAME         = aws_dynamodb_table.inspections.name
      SSM_PREFIX         = local.ssm_prefix
      RUNNER_FUNCTION    = aws_lambda_function.runner.function_name
      GLOBAL_DAILY_LIMIT = tostring(var.global_daily_limit)
    }
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}

resource "aws_lambda_function" "runner" {
  function_name    = "${local.prefix}-inspection-runner"
  role             = aws_iam_role.runner.arn
  runtime          = "nodejs22.x"
  handler          = "runner.handler"
  architectures    = ["arm64"]
  filename         = data.archive_file.runner.output_path
  source_code_hash = data.archive_file.runner.output_base64sha256
  memory_size      = 256
  timeout          = 240 # 8 sequential probes at ~2-12s each, plus SSM agent pickup

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.inspections.name
      SSM_PREFIX = local.ssm_prefix
    }
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}
