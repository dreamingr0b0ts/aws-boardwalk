# The two demo-cycle Lambdas: seed (ordered checksummed migrations + in-engine
# data generation, as the master user) and report (database-to-evidence, as the
# least-privilege app user wherever possible).

data "archive_file" "seed" {
  type        = "zip"
  source_file = "${path.module}/lambda/seed.mjs"
  output_path = "${path.module}/lambda/seed.zip"
}

data "archive_file" "report" {
  type        = "zip"
  source_file = "${path.module}/lambda/report.mjs"
  output_path = "${path.module}/lambda/report.zip"
}

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
  master_secret_arn = aws_rds_cluster.registry.master_user_secret[0].secret_arn

  data_api_actions = [
    "rds-data:ExecuteStatement",
    "rds-data:BeginTransaction",
    "rds-data:CommitTransaction",
    "rds-data:RollbackTransaction",
  ]
}

# ---- seed ------------------------------------------------------------------

resource "aws_iam_role" "seed" {
  name               = "${local.prefix}-seed-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "seed_logs" {
  role       = aws_iam_role.seed.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "seed_xray" {
  role       = aws_iam_role.seed.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

resource "aws_iam_role_policy" "seed" {
  name = "migrate-and-seed"
  role = aws_iam_role.seed.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "DataApiAsMaster"
        Effect   = "Allow"
        Action   = local.data_api_actions
        Resource = aws_rds_cluster.registry.arn
      },
      {
        Sid      = "ReadCredentials"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [local.master_secret_arn, aws_secretsmanager_secret.app.arn]
      },
    ]
  })
}

resource "aws_lambda_function" "seed" {
  function_name    = "${local.prefix}-seed"
  role             = aws_iam_role.seed.arn
  runtime          = "nodejs22.x"
  handler          = "seed.handler"
  architectures    = ["arm64"]
  filename         = data.archive_file.seed.output_path
  source_code_hash = data.archive_file.seed.output_base64sha256
  timeout          = 300 # may sit out a cold resume before the first statement lands
  memory_size      = 256

  environment {
    variables = {
      CLUSTER_ARN       = aws_rds_cluster.registry.arn
      MASTER_SECRET_ARN = local.master_secret_arn
      APP_SECRET_ARN    = aws_secretsmanager_secret.app.arn
      DATABASE          = aws_rds_cluster.registry.database_name
    }
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_rds_cluster_instance.registry]
}

# ---- report ----------------------------------------------------------------

resource "aws_iam_role" "report" {
  name               = "${local.prefix}-report-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "report_logs" {
  role       = aws_iam_role.report.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "report_xray" {
  role       = aws_iam_role.report.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

resource "aws_iam_role_policy" "report" {
  name = "database-to-evidence"
  role = aws_iam_role.report.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "DataApiAsAppUser"
        Effect   = "Allow"
        Action   = local.data_api_actions
        Resource = aws_rds_cluster.registry.arn
      },
      {
        Sid      = "ReadCredentials"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [local.master_secret_arn, aws_secretsmanager_secret.app.arn]
      },
      {
        Sid      = "DescribeCluster"
        Effect   = "Allow"
        Action   = ["rds:DescribeDBClusters"]
        Resource = aws_rds_cluster.registry.arn
      },
      {
        Sid      = "WriteEvidence"
        Effect   = "Allow"
        Action   = "s3:PutObject"
        Resource = "${data.terraform_remote_state.infra.outputs.site_bucket_arn}/evidence/*"
      },
    ]
  })
}

resource "aws_lambda_function" "report" {
  function_name    = "${local.prefix}-evidence-report"
  role             = aws_iam_role.report.arn
  runtime          = "nodejs22.x"
  handler          = "report.handler"
  architectures    = ["arm64"]
  filename         = data.archive_file.report.output_path
  source_code_hash = data.archive_file.report.output_base64sha256
  timeout          = 300 # may include a full 0-ACU resume (measured into the evidence)
  memory_size      = 256

  environment {
    variables = {
      CLUSTER_ARN       = aws_rds_cluster.registry.arn
      CLUSTER_ID        = aws_rds_cluster.registry.cluster_identifier
      MASTER_SECRET_ARN = local.master_secret_arn
      APP_SECRET_ARN    = aws_secretsmanager_secret.app.arn
      DATABASE          = aws_rds_cluster.registry.database_name
      SITE_BUCKET       = data.terraform_remote_state.infra.outputs.site_bucket
    }
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_rds_cluster_instance.registry]
}

# ---- outputs ---------------------------------------------------------------

output "cluster_id" {
  value = aws_rds_cluster.registry.cluster_identifier
}

output "cluster_arn" {
  value = aws_rds_cluster.registry.arn
}

output "seed_function" {
  value = aws_lambda_function.seed.function_name
}

output "report_function" {
  value = aws_lambda_function.report.function_name
}
