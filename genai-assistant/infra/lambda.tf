# Handlers are bundled by ../backend/build.mjs (esbuild) into
# ../backend/dist/<name>/index.mjs before terraform runs — `make deploy`
# guarantees the ordering.

locals {
  handlers = ["public", "chat", "ingest"]
}

data "archive_file" "handler" {
  for_each    = toset(local.handlers)
  type        = "zip"
  source_dir  = "${path.module}/../backend/dist/${each.key}"
  output_path = "${path.module}/build/${each.key}.zip"
}

resource "aws_lambda_function" "public" {
  function_name    = "${local.prefix}-public"
  role             = aws_iam_role.public.arn
  filename         = data.archive_file.handler["public"].output_path
  source_code_hash = data.archive_file.handler["public"].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  memory_size      = 256
  timeout          = 10

  environment {
    variables = {
      CORPUS_BUCKET      = aws_s3_bucket.corpus.bucket
      USER_DAILY_LIMIT   = tostring(var.user_daily_limit)
      GLOBAL_DAILY_LIMIT = tostring(var.global_daily_limit)
    }
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}

resource "aws_lambda_function" "chat" {
  function_name    = "${local.prefix}-chat"
  role             = aws_iam_role.chat.arn
  filename         = data.archive_file.handler["chat"].output_path
  source_code_hash = data.archive_file.handler["chat"].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  memory_size      = 512
  timeout          = 29 # just under the HTTP API integration ceiling

  environment {
    variables = {
      TABLE_NAME         = aws_dynamodb_table.assistant.name
      CORPUS_BUCKET      = aws_s3_bucket.corpus.bucket
      MODEL_ID           = var.model_id
      EMBED_MODEL_ID     = var.embed_model_id
      USER_DAILY_LIMIT   = tostring(var.user_daily_limit)
      GLOBAL_DAILY_LIMIT = tostring(var.global_daily_limit)
    }
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}

resource "aws_lambda_function" "ingest" {
  function_name    = "${local.prefix}-ingest"
  role             = aws_iam_role.ingest.arn
  filename         = data.archive_file.handler["ingest"].output_path
  source_code_hash = data.archive_file.handler["ingest"].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  memory_size      = 512
  timeout          = 300 # serial Titan calls over the whole corpus

  environment {
    variables = {
      CORPUS_BUCKET  = aws_s3_bucket.corpus.bucket
      EMBED_MODEL_ID = var.embed_model_id
    }
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}
