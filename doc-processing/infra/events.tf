# Every object that lands under incoming/ starts a pipeline execution — the
# same path whether it arrived via the site's presigned POST or `make seed`.
resource "aws_cloudwatch_event_rule" "object_created" {
  name        = "${local.prefix}-object-created"
  description = "S3 incoming/* object creations -> IDP pipeline"

  event_pattern = jsonencode({
    source      = ["aws.s3"]
    detail-type = ["Object Created"]
    detail = {
      bucket = { name = [aws_s3_bucket.docs.bucket] }
      object = { key = [{ prefix = "incoming/" }] }
    }
  })
}

resource "aws_cloudwatch_event_target" "start_pipeline" {
  rule     = aws_cloudwatch_event_rule.object_created.name
  arn      = aws_sfn_state_machine.pipeline.arn
  role_arn = aws_iam_role.events.arn
}

# Nightly broom: purge user uploads so the index resets to the seeded corpus
# (09:00 UTC, the boardwalk's shared reset hour).
resource "aws_cloudwatch_event_rule" "nightly_reset" {
  name                = "${local.prefix}-nightly-reset"
  description         = "Purge uploaded demo documents"
  schedule_expression = "cron(0 9 * * ? *)"
}

resource "aws_cloudwatch_event_target" "reset" {
  rule = aws_cloudwatch_event_rule.nightly_reset.name
  arn  = aws_lambda_function.reset.arn
}

resource "aws_lambda_permission" "reset_from_events" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.reset.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.nightly_reset.arn
}
