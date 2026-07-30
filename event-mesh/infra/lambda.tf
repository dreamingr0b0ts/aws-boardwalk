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

  race_json = jsonencode({
    standardUrl = aws_sqs_queue.race_standard.url
    fifoUrl     = aws_sqs_queue.race_fifo.url
  })

  # The interlocking tester checks visitor events against the mesh's REAL
  # rules. Reading the patterns off the rule resources themselves means the
  # tester can never drift from what the bus actually matches.
  rule_patterns_json = jsonencode(concat(
    [for d in local.departments : {
      name        = "route-${d}"
      description = "routes to the ${d} dispatch queue"
      pattern     = aws_cloudwatch_event_rule.route[d].event_pattern
    }],
    [
      {
        name        = "notify-all"
        description = "fans out through SNS to every subscriber"
        pattern     = aws_cloudwatch_event_rule.notify_all.event_pattern
      },
      {
        name        = "escalate-urgent"
        description = "starts the Step Functions escalation"
        pattern     = aws_cloudwatch_event_rule.escalate_urgent.event_pattern
      },
    ]
  ))
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
      TABLE_NAME          = aws_dynamodb_table.events.name
      BUS_NAME            = aws_cloudwatch_event_bus.mesh.name
      BUS_ARN             = aws_cloudwatch_event_bus.mesh.arn
      EVENT_SOURCE        = local.event_source
      QUEUES_JSON         = local.queues_json
      RACE_JSON           = local.race_json
      RULE_PATTERNS_JSON  = local.rule_patterns_json
      ARCHIVE_NAME        = aws_cloudwatch_event_archive.mesh.name
      ARCHIVE_ARN         = aws_cloudwatch_event_archive.mesh.arn
      GLOBAL_DAILY_LIMIT  = tostring(var.global_daily_limit)
      PATTERN_DAILY_LIMIT = tostring(var.pattern_daily_limit)
      RACE_DAILY_LIMIT    = tostring(var.race_daily_limit)
      REPLAY_DAILY_LIMIT  = tostring(var.replay_daily_limit)
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

# Race queues get one car per invoke (batch_size = 1): standard-queue cars
# arrive via concurrent invokes that genuinely race, FIFO cars arrive
# sequentially because a single message group is never delivered in parallel.
resource "aws_lambda_event_source_mapping" "race_standard" {
  event_source_arn        = aws_sqs_queue.race_standard.arn
  function_name           = aws_lambda_function.worker.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
}

resource "aws_lambda_event_source_mapping" "race_fifo" {
  event_source_arn        = aws_sqs_queue.race_fifo.arn
  function_name           = aws_lambda_function.worker.arn
  batch_size              = 1
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
