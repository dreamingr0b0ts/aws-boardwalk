# Handlers are bundled by ../backend/build.mjs (esbuild) into
# ../backend/dist/<name>/index.mjs before terraform runs — `make deploy`
# guarantees the ordering.

locals {
  handlers = ["permits", "licenses", "facilities", "status"]

  service_tables = {
    permits    = aws_dynamodb_table.permits.name
    licenses   = aws_dynamodb_table.licenses.name
    facilities = aws_dynamodb_table.facilities.name
  }
}

data "archive_file" "handler" {
  for_each    = toset(local.handlers)
  type        = "zip"
  source_dir  = "${path.module}/../backend/dist/${each.key}"
  output_path = "${path.module}/build/${each.key}.zip"
}

resource "aws_lambda_function" "permits" {
  function_name    = "${local.prefix}-permits-svc"
  role             = aws_iam_role.permits.arn
  filename         = data.archive_file.handler["permits"].output_path
  source_code_hash = data.archive_file.handler["permits"].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  memory_size      = 256
  timeout          = 10

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.permits.name
    }
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}

resource "aws_lambda_function" "licenses" {
  function_name    = "${local.prefix}-licenses-svc"
  role             = aws_iam_role.licenses.arn
  filename         = data.archive_file.handler["licenses"].output_path
  source_code_hash = data.archive_file.handler["licenses"].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  memory_size      = 256
  timeout          = 10

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.licenses.name
    }
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}

resource "aws_lambda_function" "facilities" {
  function_name    = "${local.prefix}-facilities-svc"
  role             = aws_iam_role.facilities.arn
  filename         = data.archive_file.handler["facilities"].output_path
  source_code_hash = data.archive_file.handler["facilities"].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  memory_size      = 256
  timeout          = 10

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.facilities.name
    }
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}

resource "aws_lambda_function" "status" {
  function_name    = "${local.prefix}-status-svc"
  role             = aws_iam_role.status.arn
  filename         = data.archive_file.handler["status"].output_path
  source_code_hash = data.archive_file.handler["status"].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  memory_size      = 256
  timeout          = 10

  environment {
    variables = {
      SERVICE_TABLES_JSON = jsonencode(local.service_tables)
    }
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}
