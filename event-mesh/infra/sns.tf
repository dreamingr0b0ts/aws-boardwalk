# One topic, two very different subscribers — the classic pub/sub fan-out:
# a Lambda (the citizen notifier) and an SQS queue (the durable audit copy).
#
# Deliberately unencrypted: EventBridge cannot publish to a topic encrypted
# with the AWS-managed aws/sns key (the key policy doesn't grant
# events.amazonaws.com kms:GenerateDataKey), and a customer-managed key costs
# $1/mo for a demo topic carrying fictional pothole reports. Documented as a
# Checkov skip in ../.checkov.yaml.
resource "aws_sns_topic" "notifications" {
  name = "${local.prefix}-notifications"
}

data "aws_iam_policy_document" "notifications_from_events" {
  statement {
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.notifications.arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.notify_all.arn]
    }
  }
}

resource "aws_sns_topic_policy" "notifications" {
  arn    = aws_sns_topic.notifications.arn
  policy = data.aws_iam_policy_document.notifications_from_events.json
}

resource "aws_sns_topic_subscription" "notifier" {
  topic_arn = aws_sns_topic.notifications.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.notify.arn
}

resource "aws_lambda_permission" "notify_from_sns" {
  statement_id  = "AllowSNSInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.notify.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.notifications.arn
}

resource "aws_sns_topic_subscription" "audit" {
  topic_arn            = aws_sns_topic.notifications.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.audit.arn
  raw_message_delivery = true
}
