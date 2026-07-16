# The "or scheduled" half of run-task: one containerized report job a day,
# launched by EventBridge Scheduler with no Lambda in between. It also keeps
# the recent-runs feed populated between visitors. NOTE (learned on plank 3):
# Scheduler does NOT substitute <aws.scheduler.execution-id> into inputs —
# nothing here relies on it; the container derives its run id from the ECS
# task metadata endpoint instead.

resource "aws_scheduler_schedule" "daily_report" {
  name = "${local.prefix}-daily-report"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression = var.scheduled_report

  target {
    arn      = aws_ecs_cluster.works.arn
    role_arn = aws_iam_role.scheduler.arn

    ecs_parameters {
      # arn_without_revision → the schedule always launches the latest ACTIVE
      # revision instead of pinning (and drifting from) a specific one.
      task_definition_arn = aws_ecs_task_definition.app.arn_without_revision
      launch_type         = "FARGATE"
      task_count          = 1

      network_configuration {
        subnets          = data.aws_subnets.default_public.ids
        security_groups  = [aws_security_group.task.id]
        assign_public_ip = true
      }
    }

    input = jsonencode({
      containerOverrides = [{
        name = "app"
        environment = [
          { name = "JOB", value = "report" },
          { name = "SOURCE", value = "schedule" },
        ]
      }]
    })
  }
}
