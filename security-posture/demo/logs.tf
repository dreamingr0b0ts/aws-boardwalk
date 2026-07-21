# Explicit log group for the report Lambda: an auto-created group would
# outlive the teardown with never-expire retention; this one is created and
# destroyed with the demo stack.
resource "aws_cloudwatch_log_group" "lambda_logs" {
  for_each          = toset(["evidence-report"])
  name              = "/aws/lambda/${local.prefix}-${each.key}"
  retention_in_days = 14
}
