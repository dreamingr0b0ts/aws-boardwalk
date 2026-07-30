# Visitor-facing live exhibits, served same-origin behind CloudFront /api/*:
#
#   POST /api/drill       start the real backup/restore drill (Step Functions)
#   GET  /api/drill/{id}  live stage timeline read from the execution history
#   POST /api/sweep       send patrol on the closing sweep of all 13 live sites
#   GET  /api/sweep/{id}  per-site results as the runner works down the mountain
#   GET  /api/ci          recent pipeline runs, proxied from the GitHub API
#   GET  /api/cost        month-to-date spend per plank via Cost Explorer
#   GET  /api/status      day-book counters + whatever is under way right now
#
# Guardrails mirror planks 4 and 9: one drill / one sweep at a time (extra
# POSTs get a 409 pointing at the run under way so visitors share the live
# view), atomic global daily counters, and the API-Gateway edge throttle in
# front of everything. Worst case per day: 10 drill runs at about a cent each
# plus one $0.02 Cost Explorer refresh.

locals {
  # Every live boardwalk site the closing sweep skis, in hub display order.
  sweep_sites = [
    { id = "hub", host = "demos.planetek.org", name = "Demo Hub" },
    { id = "permits", host = "permits.demos.planetek.org", name = "Permits" },
    { id = "assistant", host = "assistant.demos.planetek.org", name = "Assistant" },
    { id = "documents", host = "documents.demos.planetek.org", name = "Documents" },
    { id = "models", host = "models.demos.planetek.org", name = "Models" },
    { id = "api", host = "api.demos.planetek.org", name = "API" },
    { id = "events", host = "events.demos.planetek.org", name = "Events" },
    { id = "containers", host = "containers.demos.planetek.org", name = "Containers" },
    { id = "data", host = "data.demos.planetek.org", name = "Data" },
    { id = "registry", host = "registry.demos.planetek.org", name = "Registry" },
    { id = "security", host = "security.demos.planetek.org", name = "Security" },
    { id = "network", host = "network.demos.planetek.org", name = "Network" },
    { id = "ops", host = "ops.demos.planetek.org", name = "Ops" },
  ]
}

# --- single table for runs, locks, counters, and API caches -------------------
#   RUN#<id> / META         one record per drill or sweep run (48h TTL)
#   LOCK / DRILL|SWEEP      one-at-a-time gates; extra POSTs 409-attach
#   USAGE#<date> / GLOBAL   atomic daily counters (drills + sweeps)
#   CI / LATEST             last shaped GitHub payload (fallback when rate-limited)
#   COST / LATEST           Cost Explorer snapshot, refreshed at most daily

resource "aws_dynamodb_table" "exhibits" {
  name         = "${local.prefix}-exhibits"
  billing_mode = "PAY_PER_REQUEST"

  hash_key  = "PK"
  range_key = "SK"

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }
}

# --- Lambdas (plain ESM, no build; SDK v3 ships in the nodejs22 runtime) ------

data "archive_file" "exhibit_api" {
  type        = "zip"
  source_file = "${path.module}/../exhibits/api.mjs"
  output_path = "${path.module}/build/exhibit-api.zip"
}

data "archive_file" "sweep_runner" {
  type        = "zip"
  source_file = "${path.module}/../exhibits/sweep.mjs"
  output_path = "${path.module}/build/sweep-runner.zip"
}

resource "aws_iam_role" "exhibit_api" {
  name = "${local.prefix}-exhibit-api"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "exhibit_api" {
  name = "exhibit-api"
  role = aws_iam_role.exhibit_api.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "Table"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"]
        Resource = aws_dynamodb_table.exhibits.arn
      },
      {
        Sid      = "StartDrill"
        Effect   = "Allow"
        Action   = ["states:StartExecution"]
        Resource = aws_sfn_state_machine.runbook.arn
      },
      {
        Sid      = "WatchDrill"
        Effect   = "Allow"
        Action   = ["states:DescribeExecution", "states:GetExecutionHistory"]
        Resource = "arn:aws:states:${local.region}:${local.account_id}:execution:${aws_sfn_state_machine.runbook.name}:*"
      },
      {
        Sid      = "DispatchSweep"
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = aws_lambda_function.sweep_runner.arn
      },
      {
        # Cost Explorer supports no resource-level scoping; the read is
        # memoized in DynamoDB so it fires at most once per day.
        Sid      = "SeasonLedger"
        Effect   = "Allow"
        Action   = ["ce:GetCostAndUsage"]
        Resource = "*"
      },
      {
        Sid      = "Logs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/${local.prefix}-*"
      },
      {
        Sid      = "Xray"
        Effect   = "Allow"
        Action   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
        Resource = "*"
      },
    ]
  })
}

resource "aws_iam_role" "sweep_runner" {
  name = "${local.prefix}-sweep-runner"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "sweep_runner" {
  name = "sweep-runner"
  role = aws_iam_role.sweep_runner.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "Table"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.exhibits.arn
      },
      {
        Sid      = "Logs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/${local.prefix}-*"
      },
      {
        Sid      = "Xray"
        Effect   = "Allow"
        Action   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
        Resource = "*"
      },
    ]
  })
}

resource "aws_lambda_function" "exhibit_api" {
  function_name    = "${local.prefix}-exhibit-api"
  role             = aws_iam_role.exhibit_api.arn
  runtime          = "nodejs22.x"
  handler          = "api.handler"
  architectures    = ["arm64"]
  filename         = data.archive_file.exhibit_api.output_path
  source_code_hash = data.archive_file.exhibit_api.output_base64sha256
  memory_size      = 256
  timeout          = 15

  environment {
    variables = {
      TABLE_NAME        = aws_dynamodb_table.exhibits.name
      SFN_ARN           = aws_sfn_state_machine.runbook.arn
      RUNNER_FUNCTION   = aws_lambda_function.sweep_runner.function_name
      GITHUB_REPO       = var.github_repo
      SITES             = jsonencode(local.sweep_sites)
      DRILL_DAILY_LIMIT = "10"
      SWEEP_DAILY_LIMIT = "30"
      # Mirror the Planetek-Infra-Tripwire budget: the ledger shows what the
      # infrastructure costs, not training subscriptions or tax.
      COST_EXCLUDE_SERVICES = "AWS Skill Builder Individual,Tax"
    }
  }

  tracing_config {
    mode = "Active"
  }
}

resource "aws_lambda_function" "sweep_runner" {
  function_name    = "${local.prefix}-sweep-runner"
  role             = aws_iam_role.sweep_runner.arn
  runtime          = "nodejs22.x"
  handler          = "sweep.handler"
  architectures    = ["arm64"]
  filename         = data.archive_file.sweep_runner.output_path
  source_code_hash = data.archive_file.sweep_runner.output_base64sha256
  memory_size      = 256
  timeout          = 120 # 13 sites, paced ~1s apart so the board visibly fills

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.exhibits.name
    }
  }

  tracing_config {
    mode = "Active"
  }
}

# --- HTTP API, same-origin behind CloudFront /api/* ---------------------------

resource "aws_apigatewayv2_api" "exhibits" {
  name          = "${local.prefix}-exhibits-api"
  protocol_type = "HTTP"
  description   = "Boardwalk ops live exhibits (drill, sweep, CI board, season ledger) - served same-origin behind CloudFront /api/*"
}

resource "aws_apigatewayv2_stage" "exhibits" {
  api_id      = aws_apigatewayv2_api.exhibits.id
  name        = "$default"
  auto_deploy = true

  # Nuisance bound in front of the real guardrails (locks + daily counters).
  default_route_settings {
    throttling_burst_limit = 10
    throttling_rate_limit  = 5
  }
}

locals {
  exhibit_routes = [
    "GET /api/status",
    "POST /api/drill",
    "GET /api/drill/{id}",
    "POST /api/sweep",
    "GET /api/sweep/{id}",
    "GET /api/ci",
    "GET /api/cost",
  ]
}

resource "aws_apigatewayv2_integration" "exhibits" {
  api_id                 = aws_apigatewayv2_api.exhibits.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.exhibit_api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "exhibits" {
  for_each  = toset(local.exhibit_routes)
  api_id    = aws_apigatewayv2_api.exhibits.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.exhibits.id}"
}

resource "aws_lambda_permission" "exhibits_apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.exhibit_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.exhibits.execution_arn}/*/*"
}
