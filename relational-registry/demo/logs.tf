# Explicit log groups for the demo Lambdas: auto-created groups would
# outlive the teardown with never-expire retention; these are created and
# destroyed with the demo stack.
resource "aws_cloudwatch_log_group" "lambda_logs" {
  for_each          = toset(["seed", "evidence-report"])
  name              = "/aws/lambda/${local.prefix}-${each.key}"
  retention_in_days = 14
}
