# Handlers are bundled by ../backend/build.mjs (esbuild) into
# ../backend/dist/<name>/index.mjs before terraform runs — `make deploy`
# guarantees the ordering.

locals {
  handlers = ["api", "worker", "notify", "escalate", "reset"]

  # Everything the API needs to report DLQ depths and start redrives, as one
  # env var instead of nine.
  queues_json = jsonencode({
    for d in local.departments : d => {
      queueUrl = aws_sqs_queue.dispatch[d].url
      queueArn = aws_sqs_queue.dispatch[d].arn
      dlqUrl   = aws_sqs_queue.dlq[d].url
      dlqArn   = aws_sqs_queue.dlq[d].arn
    }
  })
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
      TABLE_NAME         = aws_dynamodb_table.events.name
      BUS_NAME           = aws_cloudwatch_event_bus.mesh.name
      EVENT_SOURCE       = local.event_source
      QUEUES_JSON        = local.queues_json
      GLOBAL_DAILY_LIMIT = tostring(var.global_daily_limit)
    }
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}

# One worker, four event source mappings: the three department queues plus the
# audit queue. The handler tells them apart by eventSourceARN — same code path
# a real dispatch consumer would share.
resource "aws_lambda_function" "worker" {
  function_name    = "${local.prefix}-worker"
  role             = aws_iam_role.worker.arn
  filename         = data.archive_file.handler["worker"].output_path
  source_code_hash = data.archive_file.handler["worker"].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  memory_size      = 256
  timeout          = 10 # queues' 30s visibility timeout must stay >= this

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.events.name
    }
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}

resource "aws_lambda_event_source_mapping" "dispatch" {
  for_each = toset(local.departments)

  event_source_arn        = aws_sqs_queue.dispatch[each.key].arn
  function_name           = aws_lambda_function.worker.arn
  batch_size              = 10
  function_response_types = ["ReportBatchItemFailures"] # only the poison message retries, not its batch
}

resource "aws_lambda_event_source_mapping" "audit" {
  event_source_arn        = aws_sqs_queue.audit.arn
  function_name           = aws_lambda_function.worker.arn
  batch_size              = 10
  function_response_types = ["ReportBatchItemFailures"]
}

resource "aws_lambda_function" "notify" {
  function_name    = "${local.prefix}-notify"
  role             = aws_iam_role.notify.arn
  filename         = data.archive_file.handler["notify"].output_path
  source_code_hash = data.archive_file.handler["notify"].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  memory_size      = 256
  timeout          = 10

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.events.name
    }
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}

resource "aws_lambda_function" "escalate" {
  function_name    = "${local.prefix}-escalate"
  role             = aws_iam_role.escalate.arn
  filename         = data.archive_file.handler["escalate"].output_path
  source_code_hash = data.archive_file.handler["escalate"].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  memory_size      = 256
  timeout          = 10

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.events.name
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
      TABLE_NAME  = aws_dynamodb_table.events.name
      QUEUES_JSON = local.queues_json
    }
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}
