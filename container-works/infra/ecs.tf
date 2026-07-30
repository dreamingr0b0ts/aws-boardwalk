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

# One container recipe shared by all three task definitions below. Only the
# image tag differs; sizing lives at the task level where Fargate enforces it.
locals {
  app_container_base = {
    name      = "app"
    essential = true

    # SIGTERM → 30s grace → SIGKILL. The stubborn job exists to hit that
    # deadline on camera; the drain job exits cleanly inside it.
    stopTimeout = 30

    # The job builds its report in memory and ships it to S3 — nothing needs
    # a writable filesystem, so lock the root read-only.
    readonlyRootFilesystem = true
    user                   = "node"

    environment = [
      { name = "ARTIFACT_BUCKET", value = aws_s3_bucket.site.bucket },
      { name = "ARTIFACT_PREFIX", value = "artifacts/" },
      # Launch paths override these: the API sets visitor+job (+ race lane
      # metadata), the schedule sets schedule+report.
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
  }
}

# The everyday oven: 0.25 vCPU / 512 MiB, the smallest size Fargate sells.
resource "aws_ecs_task_definition" "app" {
  family                   = "${local.prefix}-app"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.task_exec.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64" # matches the CodeBuild builder (free tier is x86)
  }

  container_definitions = jsonencode([
    merge(local.app_container_base, {
      image = "${aws_ecr_repository.app.repository_url}:latest"
    })
  ])
}

# The bake-off's hot oven: same slim image, 4x the compute. The sizing race
# runs the identical CPU-bound job in both and lets the wall clock testify.
resource "aws_ecs_task_definition" "app_boost" {
  family                   = "${local.prefix}-app-boost"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.task_exec.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    merge(local.app_container_base, {
      image = "${aws_ecr_repository.app.repository_url}:latest"
    })
  ])
}

# The overloaded pan: the SAME app on a deliberately heavy base image (:fat,
# full Debian node instead of alpine), so the image race has a loser and the
# scan panel has two health inspections to compare.
resource "aws_ecs_task_definition" "app_fat" {
  family                   = "${local.prefix}-app-fat"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.task_exec.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    merge(local.app_container_base, {
      image = "${aws_ecr_repository.app.repository_url}:fat"
    })
  ])
}
