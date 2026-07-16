# Handlers are bundled by ../backend/build.mjs (esbuild) into
# ../backend/dist/<name>/index.mjs before terraform runs — `make deploy`
# guarantees the ordering.

locals {
  handlers = ["api", "finalize"]
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
  timeout          = 15

  environment {
    variables = {
      TABLE_NAME         = aws_dynamodb_table.runs.name
      CLUSTER_ARN        = aws_ecs_cluster.works.arn
      TASK_FAMILY        = aws_ecs_task_definition.app.family
      SUBNETS_JSON       = jsonencode(data.aws_subnets.default_public.ids)
      SECURITY_GROUP     = aws_security_group.task.id
      LOG_GROUP          = aws_cloudwatch_log_group.app.name
      ECR_REPO           = aws_ecr_repository.app.name
      CODEBUILD_PROJECT  = aws_codebuild_project.image.name
      GLOBAL_DAILY_LIMIT = tostring(var.global_daily_limit)
      MAX_CONCURRENT     = tostring(var.max_concurrent_tasks)
      TASK_ROLE_ARN      = aws_iam_role.task.arn
      TASK_EXEC_ROLE_ARN = aws_iam_role.task_exec.arn
    }
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}

# Persists a run's final state (exit code, duration, stop reason) from ECS
# task-state-change events, so runs the dashboard isn't watching — the daily
# scheduled one especially — still land complete in the recent-runs feed.
resource "aws_lambda_function" "finalize" {
  function_name    = "${local.prefix}-finalize"
  role             = aws_iam_role.finalize.arn
  filename         = data.archive_file.handler["finalize"].output_path
  source_code_hash = data.archive_file.handler["finalize"].output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  memory_size      = 256
  timeout          = 10

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.runs.name
    }
  }

  tracing_config {
    mode = "Active" # X-Ray
  }
}

resource "aws_cloudwatch_event_rule" "task_state" {
  name        = "${local.prefix}-task-state"
  description = "ECS task state changes for the ctr cluster → finalize Lambda"

  event_pattern = jsonencode({
    source        = ["aws.ecs"]
    "detail-type" = ["ECS Task State Change"]
    detail = {
      clusterArn = [aws_ecs_cluster.works.arn]
    }
  })
}

resource "aws_cloudwatch_event_target" "finalize" {
  rule = aws_cloudwatch_event_rule.task_state.name
  arn  = aws_lambda_function.finalize.arn
}

resource "aws_lambda_permission" "events_finalize" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.finalize.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.task_state.arn
}
