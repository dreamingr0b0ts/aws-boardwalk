# Two plain-ESM Lambdas from ONE zip (run.mjs + public.mjs + the shared
# scenarios.mjs module), no build step: the AWS SDK v3 clients they need ship
# inside the nodejs22 runtime. The handler name selects the file; IAM keeps
# the public function away from Bedrock entirely.

data "archive_file" "handlers" {
  type        = "zip"
  source_dir  = "${path.module}/lambda"
  output_path = "${path.module}/build/handlers.zip"
}

resource "aws_lambda_function" "run" {
  function_name    = "${local.prefix}-run"
  role             = aws_iam_role.run.arn
  runtime          = "nodejs22.x"
  handler          = "run.handler"
  architectures    = ["arm64"]
  filename         = data.archive_file.handlers.output_path
  source_code_hash = data.archive_file.handlers.output_base64sha256
  memory_size      = 256
  timeout          = 29 # just under the HTTP API integration ceiling; four models run in parallel

  environment {
    variables = {
      TABLE_NAME              = aws_dynamodb_table.workbench.name
      MODELS                  = jsonencode(local.models)
      USER_DAILY_LIMIT        = tostring(var.user_daily_limit)
      GLOBAL_DAILY_LIMIT      = tostring(var.global_daily_limit)
      MAX_OUTPUT_TOKENS       = tostring(var.max_output_tokens)
      ANON_DAILY_LIMIT        = tostring(var.anon_daily_limit)
      ANON_GLOBAL_DAILY_LIMIT = tostring(var.anon_global_daily_limit)
      ANON_MAX_OUTPUT_TOKENS  = tostring(var.anon_max_output_tokens)
      GUARDRAIL_ID            = aws_bedrock_guardrail.workbench.guardrail_id
      GUARDRAIL_VERSION       = aws_bedrock_guardrail_version.workbench.version
    }
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}

resource "aws_lambda_function" "public" {
  function_name    = "${local.prefix}-public"
  role             = aws_iam_role.public.arn
  runtime          = "nodejs22.x"
  handler          = "public.handler"
  architectures    = ["arm64"]
  filename         = data.archive_file.handlers.output_path
  source_code_hash = data.archive_file.handlers.output_base64sha256
  memory_size      = 256
  timeout          = 10

  environment {
    variables = {
      TABLE_NAME             = aws_dynamodb_table.workbench.name
      MODELS                 = jsonencode(local.models)
      USER_DAILY_LIMIT       = tostring(var.user_daily_limit)
      GLOBAL_DAILY_LIMIT     = tostring(var.global_daily_limit)
      MAX_OUTPUT_TOKENS      = tostring(var.max_output_tokens)
      ANON_DAILY_LIMIT       = tostring(var.anon_daily_limit)
      ANON_MAX_OUTPUT_TOKENS = tostring(var.anon_max_output_tokens)
    }
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}
