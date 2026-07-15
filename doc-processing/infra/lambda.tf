# Handlers are bundled by ../backend/build.mjs (esbuild) into
# ../backend/dist/<name>/index.mjs before terraform runs — `make deploy`
# guarantees the ordering.

locals {
  handlers = ["api", "ocr", "enrich", "reset"]
}

data "archive_file" "handler" {
  for_each    = toset(local.handlers)
  type        = "zip"
  source_dir  = "${path.module}/../backend/dist/${each.key}"
  output_path = "${path.module}/build/${each.key}.zip"
}

resource "aws_lambda_function" "api" {
  function_name    = "${local.prefix}-api"
  role             = aws_iam_role.api.arn
  filename         = data.archive_file.handler["api"].output_path
  source_code_hash = data.archive_file.handler["api"].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  memory_size      = 256
  timeout          = 10

  environment {
    variables = {
      TABLE_NAME         = aws_dynamodb_table.documents.name
      DOCS_BUCKET        = aws_s3_bucket.docs.bucket
      MAX_UPLOAD_BYTES   = tostring(var.max_upload_bytes)
      USER_DAILY_LIMIT   = tostring(var.user_daily_limit)
      GLOBAL_DAILY_LIMIT = tostring(var.global_daily_limit)
    }
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}

resource "aws_lambda_function" "ocr" {
  function_name    = "${local.prefix}-ocr"
  role             = aws_iam_role.ocr.arn
  filename         = data.archive_file.handler["ocr"].output_path
  source_code_hash = data.archive_file.handler["ocr"].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  memory_size      = 512
  timeout          = 120 # PDF parse + full Textract block pagination

  environment {
    variables = {
      TABLE_NAME       = aws_dynamodb_table.documents.name
      DOCS_BUCKET      = aws_s3_bucket.docs.bucket
      MAX_UPLOAD_BYTES = tostring(var.max_upload_bytes)
      MAX_PAGES        = tostring(var.max_pages)
    }
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}

resource "aws_lambda_function" "enrich" {
  function_name    = "${local.prefix}-enrich"
  role             = aws_iam_role.enrich.arn
  filename         = data.archive_file.handler["enrich"].output_path
  source_code_hash = data.archive_file.handler["enrich"].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  memory_size      = 512
  timeout          = 60

  environment {
    variables = {
      TABLE_NAME  = aws_dynamodb_table.documents.name
      DOCS_BUCKET = aws_s3_bucket.docs.bucket
      MODEL_ID    = var.model_id
    }
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}

resource "aws_lambda_function" "reset" {
  function_name    = "${local.prefix}-reset"
  role             = aws_iam_role.reset.arn
  filename         = data.archive_file.handler["reset"].output_path
  source_code_hash = data.archive_file.handler["reset"].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  memory_size      = 256
  timeout          = 120

  environment {
    variables = {
      TABLE_NAME  = aws_dynamodb_table.documents.name
      DOCS_BUCKET = aws_s3_bucket.docs.bucket
    }
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}
