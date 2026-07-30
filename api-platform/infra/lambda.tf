# Handlers are bundled by ../backend/build.mjs (esbuild) into
# ../backend/dist/<name>/index.mjs before terraform runs — `make deploy`
# guarantees the ordering.

locals {
  handlers = ["permits", "licenses", "facilities", "status", "platform", "exports", "exports-worker"]

  # The three catalog services (what the exports worker may read).
  catalog_tables = {
    permits    = aws_dynamodb_table.permits.name
    licenses   = aws_dynamodb_table.licenses.name
    facilities = aws_dynamodb_table.facilities.name
  }

  # What /v2/status reports on — catalogs plus the exports job book.
  service_tables = merge(local.catalog_tables, {
    exports = aws_dynamodb_table.exports.name
  })
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

# Platform service: usage meter, self-service visitor keys, nightly key sweep.
# Plans and the demo key are addressed by NAME, resolved to ids at runtime —
# passing their generated ids through env vars would cycle (function → plan →
# stage → API body → function).
resource "aws_lambda_function" "platform" {
  function_name    = "${local.prefix}-platform-svc"
  role             = aws_iam_role.platform.arn
  filename         = data.archive_file.handler["platform"].output_path
  source_code_hash = data.archive_file.handler["platform"].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  memory_size      = 256
  timeout          = 30 # the nightly sweep pages through visitor keys

  environment {
    variables = {
      TABLE_NAME          = aws_dynamodb_table.platform.name
      DEMO_PLAN_NAME      = "${local.prefix}-demo"
      DEMO_KEY_NAME       = "${local.prefix}-demo-key"
      VISITOR_PLAN_NAME   = "${local.prefix}-visitor"
      DEMO_QUOTA          = var.demo_quota_per_day
      VISITOR_QUOTA       = var.visitor_quota_per_day
      KEYS_PER_IP_PER_DAY = var.visitor_keys_per_ip_per_day
      KEYS_PER_DAY_GLOBAL = var.visitor_keys_per_day
    }
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}

# Exports service, API half: accepts jobs (202 + Location), reports them,
# presigns finished artifacts. Never does the export work itself.
resource "aws_lambda_function" "exports_api" {
  function_name    = "${local.prefix}-exports-svc"
  role             = aws_iam_role.exports_api.arn
  filename         = data.archive_file.handler["exports"].output_path
  source_code_hash = data.archive_file.handler["exports"].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  memory_size      = 256
  timeout          = 10

  environment {
    variables = {
      TABLE_NAME      = aws_dynamodb_table.exports.name
      QUEUE_URL       = aws_sqs_queue.export_jobs.url
      BUCKET          = aws_s3_bucket.exports.bucket
      EXPORTS_PER_DAY = var.exports_per_day
    }
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}

# Exports service, worker half: queue-fed, reads the catalogs, writes the
# artifact, stamps the job done.
resource "aws_lambda_function" "exports_worker" {
  function_name    = "${local.prefix}-exports-worker"
  role             = aws_iam_role.exports_worker.arn
  filename         = data.archive_file.handler["exports-worker"].output_path
  source_code_hash = data.archive_file.handler["exports-worker"].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  memory_size      = 256
  timeout          = 30

  environment {
    variables = {
      JOBS_TABLE          = aws_dynamodb_table.exports.name
      BUCKET              = aws_s3_bucket.exports.bucket
      SERVICE_TABLES_JSON = jsonencode(local.catalog_tables)
    }
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}
