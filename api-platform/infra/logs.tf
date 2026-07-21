# Explicit log groups for every Lambda: auto-created groups never expire,
# these keep the 14-day retention posture.
resource "aws_cloudwatch_log_group" "lambda_logs" {
  for_each          = toset(["permits-svc", "licenses-svc", "facilities-svc", "status-svc"])
  name              = "/aws/lambda/${local.prefix}-${each.key}"
  retention_in_days = 14
}
