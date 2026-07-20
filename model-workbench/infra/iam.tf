# One role per function, least privilege per function. Only the run Lambda
# can invoke models — and only the four on the roster; the public Lambda can
# read the aggregate counters and touches no AI at all.

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
    run    = aws_iam_role.run
    public = aws_iam_role.public
  }
}

resource "aws_iam_role" "run" {
  name               = "${local.prefix}-run-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "public" {
  name               = "${local.prefix}-public-api"
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

resource "aws_iam_role_policy" "run" {
  name = "roster-models-and-guardrails"
  role = aws_iam_role.run.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "RateLimitCountersAndLedger"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem", "dynamodb:Query"]
        Resource = aws_dynamodb_table.workbench.arn
      },
      {
        Sid      = "InvokeRosterModelsOnly"
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel"]
        Resource = local.model_invoke_arns
      },
    ]
  })
}

resource "aws_iam_role_policy" "public" {
  name = "aggregate-counters-only"
  role = aws_iam_role.public.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "ReadDailyCounters"
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem"]
      Resource = aws_dynamodb_table.workbench.arn
    }]
  })
}
