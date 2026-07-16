# One role per function, least privilege per function: only the api can
# publish to the bus or start a DLQ redrive, only the worker consumes queues,
# and reset is the only purger/deleter.

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

locals {
  lambda_roles = {
    api      = aws_iam_role.api
    worker   = aws_iam_role.worker
    notify   = aws_iam_role.notify
    escalate = aws_iam_role.escalate
    reset    = aws_iam_role.reset
  }

  dispatch_queue_arns = [for d in local.departments : aws_sqs_queue.dispatch[d].arn]
  dlq_arns            = [for d in local.departments : aws_sqs_queue.dlq[d].arn]
}

resource "aws_iam_role" "api" {
  name               = "${local.prefix}-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "worker" {
  name               = "${local.prefix}-worker"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "notify" {
  name               = "${local.prefix}-notify"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "escalate" {
  name               = "${local.prefix}-escalate"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "reset" {
  name               = "${local.prefix}-reset"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "basic_logs" {
  for_each   = local.lambda_roles
  role       = each.value.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# X-Ray tracing (plank 10 wires the observability side)
resource "aws_iam_role_policy_attachment" "xray_write" {
  for_each   = local.lambda_roles
  role       = each.value.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

resource "aws_iam_role_policy" "api_all" {
  name = "publish-trace-and-redrive"
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "PublishToBus"
        Effect   = "Allow"
        Action   = ["events:PutEvents"]
        Resource = aws_cloudwatch_event_bus.mesh.arn
      },
      {
        Sid      = "TraceReadsWritesAndCounters"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:Scan"]
        Resource = aws_dynamodb_table.events.arn
      },
      {
        Sid      = "DlqDepthsForStats"
        Effect   = "Allow"
        Action   = ["sqs:GetQueueAttributes"]
        Resource = local.dlq_arns
      },
      {
        # The dashboard's "operator redrive" button. The move task also needs
        # receive/delete on the DLQ (source) and send on the work queue.
        Sid      = "OperatorRedrive"
        Effect   = "Allow"
        Action   = ["sqs:StartMessageMoveTask", "sqs:ReceiveMessage", "sqs:DeleteMessage"]
        Resource = local.dlq_arns
      },
      {
        Sid      = "RedriveDestination"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = local.dispatch_queue_arns
      },
    ]
  })
}

resource "aws_iam_role_policy" "worker_all" {
  name = "consume-queues-and-trace"
  role = aws_iam_role.worker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ConsumeDispatchAndAudit"
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = concat(local.dispatch_queue_arns, [aws_sqs_queue.audit.arn])
      },
      {
        Sid      = "TraceWrites"
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"]
        Resource = aws_dynamodb_table.events.arn
      },
    ]
  })
}

resource "aws_iam_role_policy" "notify_all" {
  name = "trace-writes"
  role = aws_iam_role.notify.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "TraceWrites"
      Effect   = "Allow"
      Action   = ["dynamodb:PutItem", "dynamodb:UpdateItem"]
      Resource = aws_dynamodb_table.events.arn
    }]
  })
}

resource "aws_iam_role_policy" "escalate_all" {
  name = "trace-writes"
  role = aws_iam_role.escalate.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "TraceWrites"
      Effect   = "Allow"
      Action   = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"]
      Resource = aws_dynamodb_table.events.arn
    }]
  })
}

resource "aws_iam_role_policy" "reset_all" {
  name = "sweep-traces-and-purge-dlqs"
  role = aws_iam_role.reset.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "SweepTraces"
        Effect   = "Allow"
        Action   = ["dynamodb:Scan", "dynamodb:BatchWriteItem", "dynamodb:DeleteItem"]
        Resource = aws_dynamodb_table.events.arn
      },
      {
        Sid      = "PurgeDlqs"
        Effect   = "Allow"
        Action   = ["sqs:PurgeQueue", "sqs:GetQueueAttributes"]
        Resource = local.dlq_arns
      },
    ]
  })
}

# --- Step Functions escalation role ------------------------------------------

data "aws_iam_policy_document" "sfn_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "escalation" {
  name               = "${local.prefix}-escalation"
  assume_role_policy = data.aws_iam_policy_document.sfn_assume.json
}

resource "aws_iam_role_policy" "escalation_all" {
  name = "invoke-steps-and-mark-failed"
  role = aws_iam_role.escalation.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "InvokeEscalateSteps"
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = aws_lambda_function.escalate.arn
      },
      {
        # MarkEscalationFailed is a direct DynamoDB integration — no Lambda
        Sid      = "MarkFailed"
        Effect   = "Allow"
        Action   = ["dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.events.arn
      },
      {
        # Express state machines with logging need these on * (CloudWatch
        # Logs delivery has no resource-level support for them).
        Sid    = "VendedLogDelivery"
        Effect = "Allow"
        Action = [
          "logs:CreateLogDelivery",
          "logs:GetLogDelivery",
          "logs:UpdateLogDelivery",
          "logs:DeleteLogDelivery",
          "logs:ListLogDeliveries",
          "logs:PutResourcePolicy",
          "logs:DescribeResourcePolicies",
          "logs:DescribeLogGroups",
        ]
        Resource = "*"
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "escalation_xray" {
  role       = aws_iam_role.escalation.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

# --- EventBridge rule -> Step Functions role ----------------------------------

data "aws_iam_policy_document" "events_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "events_to_sfn" {
  name               = "${local.prefix}-events-to-sfn"
  assume_role_policy = data.aws_iam_policy_document.events_assume.json
}

resource "aws_iam_role_policy" "events_start_escalation" {
  name = "start-escalation"
  role = aws_iam_role.events_to_sfn.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["states:StartExecution"]
      Resource = aws_sfn_state_machine.escalation.arn
    }]
  })
}

# --- EventBridge Scheduler -> bus role (the heartbeat) -------------------------

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${local.prefix}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

resource "aws_iam_role_policy" "scheduler_put_events" {
  name = "heartbeat-put-events"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["events:PutEvents"]
      Resource = aws_cloudwatch_event_bus.mesh.arn
    }]
  })
}
