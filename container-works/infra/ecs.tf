# Scale-to-zero on purpose: there is NO ECS service and never a task the
# dashboard didn't just launch (or the daily schedule). Between runs the
# cluster is an empty control-plane object that costs nothing — the whole
# point of this plank vs. an always-on service or EKS's $73/mo control plane.

resource "aws_ecs_cluster" "works" {
  name = "${local.prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "disabled" # per-metric charges; task logs + the trace table cover a demo
  }
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/aws/ecs/${local.prefix}-app"
  retention_in_days = 14
}

resource "aws_ecs_task_definition" "app" {
  family                   = "${local.prefix}-app"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256 # 0.25 vCPU — the smallest Fargate size
  memory                   = 512
  execution_role_arn       = aws_iam_role.task_exec.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64" # matches the CodeBuild builder (free tier is x86)
  }

  container_definitions = jsonencode([{
    name      = "app"
    image     = "${aws_ecr_repository.app.repository_url}:latest"
    essential = true

    # The job builds its report in memory and ships it to S3 — nothing needs
    # a writable filesystem, so lock the root read-only.
    readonlyRootFilesystem = true
    user                   = "node"

    environment = [
      { name = "ARTIFACT_BUCKET", value = aws_s3_bucket.site.bucket },
      { name = "ARTIFACT_PREFIX", value = "artifacts/" },
      # Launch paths override these: the API sets visitor+job, the schedule
      # sets schedule+report.
      { name = "JOB", value = "report" },
      { name = "SOURCE", value = "manual" },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.app.name
        "awslogs-region"        = local.region
        "awslogs-stream-prefix" = "app" # streams land at app/app/<task-id>
      }
    }
  }])
}
