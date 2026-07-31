# Explicit 14-day log groups for the always-on Lambdas (repo convention:
# auto-created groups never expire).
resource "aws_cloudwatch_log_group" "lambda_logs" {
  for_each          = toset(["exhibit-api", "drill-runner"])
  name              = "/aws/lambda/${local.prefix}-${each.key}"
  retention_in_days = 14
}
