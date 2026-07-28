# Both roles live in the always-on root but most of what they can touch only
# exists during demo windows. The runner's SendCommand is fenced two ways: the
# only document it may run is AWS-RunShellScript, and the only instances it
# may run it on are ones tagged env=network-blueprint — which the demo root
# alone creates. Between windows the grants point at nothing.

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# ---- api (gate + read) -------------------------------------------------------

resource "aws_iam_role" "api" {
  name               = "${local.prefix}-inspection-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "api_logs" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "api_xray" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

resource "aws_iam_role_policy" "api" {
  name = "inspection-gate-and-read"
  role = aws_iam_role.api.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "DiscoverDemoStack"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = "arn:aws:ssm:${local.region}:${local.account_id}:parameter${local.ssm_prefix}/*"
      },
      {
        Sid      = "CheckInstancesReady"
        Effect   = "Allow"
        Action   = "ssm:DescribeInstanceInformation"
        Resource = "*" # supports no resource-level scoping
      },
      {
        Sid      = "RunRecordsAndCounters"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"]
        Resource = aws_dynamodb_table.inspections.arn
      },
      {
        Sid      = "DispatchRunner"
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = aws_lambda_function.runner.arn
      },
    ]
  })
}

# ---- runner (walk the site) --------------------------------------------------

resource "aws_iam_role" "runner" {
  name               = "${local.prefix}-inspection-runner"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "runner_logs" {
  role       = aws_iam_role.runner.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "runner_xray" {
  role       = aws_iam_role.runner.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

resource "aws_iam_role_policy" "runner" {
  name = "inspection-probes"
  role = aws_iam_role.runner.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "DiscoverDemoStack"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = "arn:aws:ssm:${local.region}:${local.account_id}:parameter${local.ssm_prefix}/*"
      },
      {
        Sid      = "RunProbeShellScript"
        Effect   = "Allow"
        Action   = "ssm:SendCommand"
        Resource = "arn:aws:ssm:${local.region}::document/AWS-RunShellScript"
      },
      {
        Sid      = "OnlyOnThisPlanksInstances"
        Effect   = "Allow"
        Action   = "ssm:SendCommand"
        Resource = "arn:aws:ec2:${local.region}:${local.account_id}:instance/*"
        Condition = {
          StringEquals = { "ssm:resourceTag/env" = "network-blueprint" }
        }
      },
      {
        Sid      = "ReadProbeResults"
        Effect   = "Allow"
        Action   = "ssm:GetCommandInvocation"
        Resource = "*" # command ids are not known until runtime
      },
      {
        Sid      = "CheckInstancesReady"
        Effect   = "Allow"
        Action   = "ssm:DescribeInstanceInformation"
        Resource = "*" # supports no resource-level scoping
      },
      {
        Sid      = "ReadAnalyzerVerdicts"
        Effect   = "Allow"
        Action   = "ec2:DescribeNetworkInsightsAnalyses"
        Resource = "*" # EC2 Describe* calls support no resource-level scoping
      },
      {
        Sid      = "PersistRunProgress"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.inspections.arn
      },
    ]
  })
}
