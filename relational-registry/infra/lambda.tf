# One plain-ESM Lambda, no build step: the AWS SDK v3 clients it needs
# (rds-data, ssm, rds, cloudwatch, dynamodb) ship inside the nodejs22 runtime.

data "archive_file" "query" {
  type        = "zip"
  source_file = "${path.module}/lambda/query.mjs"
  output_path = "${path.module}/lambda/query.zip"
}

resource "aws_lambda_function" "query" {
  function_name    = "${local.prefix}-query-api"
  role             = aws_iam_role.query.arn
  runtime          = "nodejs22.x"
  handler          = "query.handler"
  architectures    = ["arm64"]
  filename         = data.archive_file.query.output_path
  source_code_hash = data.archive_file.query.output_base64sha256
  memory_size      = 256
  timeout          = 28 # just under the HTTP API integration ceiling; a paused cluster answers 202 fast instead of blocking

  environment {
    variables = {
      SSM_PREFIX         = local.ssm_prefix
      TABLE_NAME         = aws_dynamodb_table.registry.name
      GLOBAL_DAILY_LIMIT = tostring(var.global_daily_limit)
    }
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}
