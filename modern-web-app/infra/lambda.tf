# Handlers are bundled by ../backend/build.mjs (esbuild) into
# ../backend/dist/<name>/index.mjs before terraform runs — `make deploy`
# guarantees the ordering.

locals {
  handlers = ["public", "me", "admin", "demo", "postconfirm"]
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
      TABLE_NAME = aws_dynamodb_table.permits.name
    }
  }
}

resource "aws_lambda_function" "me" {
  function_name    = "${local.prefix}-me"
  role             = aws_iam_role.me.arn
  filename         = data.archive_file.handler["me"].output_path
  source_code_hash = data.archive_file.handler["me"].output_base64sha256
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
}

resource "aws_lambda_function" "admin" {
  function_name    = "${local.prefix}-admin"
  role             = aws_iam_role.admin.arn
  filename         = data.archive_file.handler["admin"].output_path
  source_code_hash = data.archive_file.handler["admin"].output_base64sha256
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
}

resource "aws_lambda_function" "demo" {
  function_name    = "${local.prefix}-demo-reset"
  role             = aws_iam_role.demo.arn
  filename         = data.archive_file.handler["demo"].output_path
  source_code_hash = data.archive_file.handler["demo"].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  memory_size      = 512
  timeout          = 120

  environment {
    variables = {
      TABLE_NAME            = aws_dynamodb_table.permits.name
      USER_POOL_ID          = aws_cognito_user_pool.users.id
      DEMO_ADMIN_EMAIL      = var.demo_admin_email
      DEMO_ADMIN_PASSWORD   = var.demo_admin_password
      DEMO_CITIZEN_EMAIL    = var.demo_citizen_email
      DEMO_CITIZEN_PASSWORD = var.demo_citizen_password
    }
  }
}

resource "aws_lambda_function" "postconfirm" {
  function_name    = "${local.prefix}-postconfirm"
  role             = aws_iam_role.postconfirm.arn
  filename         = data.archive_file.handler["postconfirm"].output_path
  source_code_hash = data.archive_file.handler["postconfirm"].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  memory_size      = 128
  timeout          = 5
  # No environment: the trigger event carries the user pool id.
}
