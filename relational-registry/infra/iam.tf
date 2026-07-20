# The query Lambda is the only compute in the always-on half, and its database
# identity is the exhibit: it talks to Aurora as app_user — a Postgres role
# that can SELECT the registry and write only the rollback sandbox. Even the
# AWS-side permissions below are name-fenced to rdb-* resources that only the
# demo root creates, so between demo windows they grant access to nothing.

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "query" {
  name               = "${local.prefix}-query-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "query_logs" {
  role       = aws_iam_role.query.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "query_xray" {
  role       = aws_iam_role.query.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

resource "aws_iam_role_policy" "query" {
  name = "canned-exhibits-only"
  role = aws_iam_role.query.id

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
        Sid    = "RunCannedSqlOverDataApi"
        Effect = "Allow"
        Action = [
          "rds-data:ExecuteStatement",
          "rds-data:BeginTransaction",
          "rds-data:CommitTransaction",
          "rds-data:RollbackTransaction",
        ]
        Resource = "arn:aws:rds:${local.region}:${local.account_id}:cluster:${local.prefix}-*"
      },
      {
        Sid      = "ReadAppUserCredential"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = "arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:${local.prefix}-app-credentials-*"
      },
      {
        Sid      = "DescribeClusterForStatusCard"
        Effect   = "Allow"
        Action   = ["rds:DescribeDBClusters"]
        Resource = "arn:aws:rds:${local.region}:${local.account_id}:cluster:${local.prefix}-*"
      },
      {
        Sid      = "ReadServerlessCapacityMetric"
        Effect   = "Allow"
        Action   = ["cloudwatch:GetMetricData"]
        Resource = "*" # GetMetricData supports no resource-level scoping
      },
      {
        Sid      = "DailyCounter"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.registry.arn
      },
    ]
  })
}
