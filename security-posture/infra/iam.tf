# Both roles live in the always-on root, but the drill's targets only exist
# during demo windows. The staging fence is the exhibit-grade detail: the only
# security group the runner may open (or close) is one carrying the tag
# exhibit=practice-smoke — which the demo root alone creates, attached to
# nothing. Between windows the grant points at nothing at all.

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# ---- api (gate + read + free exhibits) --------------------------------------

resource "aws_iam_role" "api" {
  name               = "${local.prefix}-exhibit-api"
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
  name = "exhibit-gate-and-read"
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
        Sid      = "RunRecordsAndCounters"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"]
        Resource = aws_dynamodb_table.exhibits.arn
      },
      {
        Sid      = "DispatchRunner"
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = aws_lambda_function.runner.arn
      },
      {
        Sid      = "PolicyDeskSimulate"
        Effect   = "Allow"
        Action   = ["iam:SimulatePrincipalPolicy", "iam:GetRole"]
        Resource = aws_iam_role.boundary_demo.arn
      },
      {
        Sid      = "PolicyDeskValidate"
        Effect   = "Allow"
        Action   = "access-analyzer:ValidatePolicy"
        Resource = "*" # ValidatePolicy is a stateless linter; it has no resource
      },
      {
        Sid      = "FenceLogSamples"
        Effect   = "Allow"
        Action   = "wafv2:GetSampledRequests"
        Resource = data.aws_wafv2_web_acl.edge.arn
      },
      {
        Sid      = "FenceLogTotals"
        Effect   = "Allow"
        Action   = ["cloudwatch:GetMetricData", "cloudwatch:ListMetrics"]
        Resource = "*" # neither call supports resource-level scoping
      },
    ]
  })
}

# ---- runner (light the smoke, watch it out) ---------------------------------

resource "aws_iam_role" "runner" {
  name               = "${local.prefix}-drill-runner"
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
  name = "practice-smoke"
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
        # Stage the misconfiguration — and, as a failsafe, put it out — on the
        # tagged sandbox group ONLY. Revoke is normally the response Lambda's
        # job (demo root); the runner keeps it so no drill can leave a smoke
        # burning if the tripwire misfires.
        Sid      = "OnlyTheSandboxGroup"
        Effect   = "Allow"
        Action   = ["ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress"]
        Resource = "arn:aws:ec2:${local.region}:${local.account_id}:security-group/*"
        Condition = {
          StringEquals = { "ec2:ResourceTag/exhibit" = "practice-smoke" }
        }
      },
      {
        Sid      = "WatchTheSmoke"
        Effect   = "Allow"
        Action   = "ec2:DescribeSecurityGroups"
        Resource = "*" # EC2 Describe* calls support no resource-level scoping
      },
      {
        Sid      = "ReadInspectorDiary"
        Effect   = "Allow"
        Action   = "config:GetComplianceDetailsByConfigRule"
        Resource = "*" # rule name is a runtime parameter from SSM discovery
      },
      {
        Sid      = "PersistRunProgress"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.exhibits.arn
      },
    ]
  })
}
