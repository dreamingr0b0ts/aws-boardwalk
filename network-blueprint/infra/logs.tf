# Explicit log groups (boardwalk convention: auto-created groups never expire).

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.prefix}-inspection-api"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "runner" {
  name              = "/aws/lambda/${local.prefix}-inspection-runner"
  retention_in_days = 14
}
