# Nightly sweep of self-issued visitor keys, five past the boardwalk-wide
# 09:00 UTC reset hour. The platform Lambda recognizes the marker payload and
# runs its sweep instead of serving a request. Deliberately delete-only: the
# schedule can expire keys, never mint them.

resource "aws_cloudwatch_event_rule" "key_sweep" {
  name                = "${local.prefix}-visitor-key-sweep"
  description         = "Delete self-issued visitor API keys older than 24h (apx-visitor-* names only)"
  schedule_expression = "cron(5 9 * * ? *)"
}

resource "aws_cloudwatch_event_target" "key_sweep" {
  rule  = aws_cloudwatch_event_rule.key_sweep.name
  arn   = aws_lambda_function.platform.arn
  input = jsonencode({ source = "boardwalk.cleanup" })
}

resource "aws_lambda_permission" "key_sweep" {
  statement_id  = "AllowEventBridgeSweep"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.platform.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.key_sweep.arn
}
