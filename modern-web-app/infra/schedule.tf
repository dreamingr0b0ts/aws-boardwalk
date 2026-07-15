# Nightly demo reset: 09:00 UTC (3am Mountain) the reset Lambda wipes the
# table, reseeds deterministic demo data, re-asserts the two demo accounts,
# and deletes any stranger sign-ups. The public demo wakes up pristine.

resource "aws_iam_role" "scheduler" {
  name = "${local.prefix}-scheduler"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "scheduler_invoke" {
  name = "invoke-demo-reset"
  role = aws_iam_role.scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = aws_lambda_function.demo.arn
    }]
  })
}

resource "aws_scheduler_schedule" "nightly_reset" {
  name                         = "${local.prefix}-nightly-reset"
  schedule_expression          = "cron(0 9 * * ? *)"
  schedule_expression_timezone = "UTC"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.demo.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ mode = "reset" })
  }
}
