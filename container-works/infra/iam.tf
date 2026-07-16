# One role per principal, least privilege each: only the api Lambda can launch
# tasks (fenced to this cluster + this task family), the task role can write
# ONLY report artifacts, the execution role can only pull + log, CodeBuild can
# push ONLY to this repo, and the scheduler can only launch the same task the
# api does.

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
    finalize = aws_iam_role.finalize
  }
}

resource "aws_iam_role" "api" {
  name               = "${local.prefix}-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "finalize" {
  name               = "${local.prefix}-finalize"
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
  name = "launch-watch-and-report"
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Launch is fenced two ways: only this task family, only this cluster.
        Sid       = "LaunchJobTask"
        Effect    = "Allow"
        Action    = ["ecs:RunTask"]
        Resource  = "arn:aws:ecs:${local.region}:${local.account_id}:task-definition/${aws_ecs_task_definition.app.family}:*"
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.works.arn } }
      },
      {
        Sid       = "PassTaskRoles"
        Effect    = "Allow"
        Action    = ["iam:PassRole"]
        Resource  = [aws_iam_role.task.arn, aws_iam_role.task_exec.arn]
        Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      },
      {
        Sid       = "WatchTasks"
        Effect    = "Allow"
        Action    = ["ecs:DescribeTasks"]
        Resource  = "arn:aws:ecs:${local.region}:${local.account_id}:task/${aws_ecs_cluster.works.name}/*"
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.works.arn } }
      },
      {
        # The concurrency gate: count in-flight tasks before launching another
        Sid      = "CountInflightTasks"
        Effect   = "Allow"
        Action   = ["ecs:ListTasks"]
        Resource = "*"
        Condition = {
          ArnEquals = { "ecs:cluster" = aws_ecs_cluster.works.arn }
        }
      },
      {
        Sid      = "TailTaskLogs"
        Effect   = "Allow"
        Action   = ["logs:GetLogEvents"]
        Resource = "${aws_cloudwatch_log_group.app.arn}:log-stream:*"
      },
      {
        Sid      = "RunRecordsAndCounters"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"]
        Resource = aws_dynamodb_table.runs.arn
      },
      {
        Sid      = "ImagePanelEcr"
        Effect   = "Allow"
        Action   = ["ecr:DescribeImages", "ecr:DescribeImageScanFindings"]
        Resource = aws_ecr_repository.app.arn
      },
      {
        Sid      = "ImagePanelBuilds"
        Effect   = "Allow"
        Action   = ["codebuild:ListBuildsForProject", "codebuild:BatchGetBuilds"]
        Resource = aws_codebuild_project.image.arn
      },
    ]
  })
}

resource "aws_iam_role_policy" "finalize_all" {
  name = "persist-final-run-state"
  role = aws_iam_role.finalize.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "RunRecords"
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
      Resource = aws_dynamodb_table.runs.arn
    }]
  })
}

# --- ECS task roles -----------------------------------------------------------

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Execution role: what the ECS agent needs to start the container (image pull
# + log delivery). The AWS-managed policy is scoped enough for a demo and is
# the documented baseline.
resource "aws_iam_role" "task_exec" {
  name               = "${local.prefix}-task-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "task_exec" {
  role       = aws_iam_role.task_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Task role: what the CODE inside the container can do — exactly one thing:
# drop its finished report under artifacts/. This split (execution role vs
# task role) is one of the things the plank exists to demonstrate.
resource "aws_iam_role" "task" {
  name               = "${local.prefix}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "task_artifacts" {
  name = "put-report-artifacts-only"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "PutReportArtifacts"
      Effect   = "Allow"
      Action   = ["s3:PutObject"]
      Resource = "${aws_s3_bucket.site.arn}/artifacts/*"
    }]
  })
}

# --- CodeBuild ----------------------------------------------------------------

data "aws_iam_policy_document" "codebuild_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["codebuild.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "codebuild" {
  name               = "${local.prefix}-codebuild"
  assume_role_policy = data.aws_iam_policy_document.codebuild_assume.json
}

resource "aws_iam_role_policy" "codebuild_all" {
  name = "build-and-push-app-image"
  role = aws_iam_role.codebuild.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "BuildLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.codebuild.arn}:*"
      },
      {
        Sid      = "FetchSourceZip"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion"]
        Resource = "${aws_s3_bucket.build_src.arn}/source/*"
      },
      {
        # GetAuthorizationToken has no resource-level support
        Sid      = "EcrLogin"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid    = "PushAppImage"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage",
        ]
        Resource = aws_ecr_repository.app.arn
      },
    ]
  })
}

# --- EventBridge Scheduler → daily run-task ------------------------------------

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

resource "aws_iam_role_policy" "scheduler_run_task" {
  name = "daily-report-run-task"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "LaunchJobTask"
        Effect    = "Allow"
        Action    = ["ecs:RunTask"]
        Resource  = "arn:aws:ecs:${local.region}:${local.account_id}:task-definition/${aws_ecs_task_definition.app.family}:*"
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.works.arn } }
      },
      {
        Sid       = "PassTaskRoles"
        Effect    = "Allow"
        Action    = ["iam:PassRole"]
        Resource  = [aws_iam_role.task.arn, aws_iam_role.task_exec.arn]
        Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      },
    ]
  })
}
