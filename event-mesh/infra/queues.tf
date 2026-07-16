# Content-based routing fans requests out to one work queue per department
# (local.departments, defined in bus.tf), each with its own dead-letter queue
# (maxReceiveCount = 3). Visibility timeout is kept short (30s ≥ 3× the
# worker's 10s timeout) so the poison-message demo reaches the DLQ in ~1
# minute instead of the textbook 6× several-minute wait.

resource "aws_sqs_queue" "dlq" {
  for_each = toset(local.departments)

  name                      = "${local.prefix}-dispatch-${each.key}-dlq"
  message_retention_seconds = 86400 # nightly reset purges; TTL'd traces expire anyway
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "dispatch" {
  for_each = toset(local.departments)

  name                       = "${local.prefix}-dispatch-${each.key}"
  visibility_timeout_seconds = 30
  message_retention_seconds  = 3600
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount     = 3
  })
}

# Only the paired work queue may redrive out of each DLQ — this is what the
# dashboard's "operator redrive" button exercises via StartMessageMoveTask.
resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  for_each  = toset(local.departments)
  queue_url = aws_sqs_queue.dlq[each.key].id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.dispatch[each.key].arn]
  })
}

# The second SNS subscriber (alongside the notifier Lambda): a queue-type
# subscriber demonstrating durable pub/sub fan-out. Raw delivery keeps the
# body identical to what the department queues receive.
resource "aws_sqs_queue" "audit" {
  name                       = "${local.prefix}-audit"
  visibility_timeout_seconds = 30
  message_retention_seconds  = 3600
  sqs_managed_sse_enabled    = true
}

# EventBridge rules (not arbitrary principals) may enqueue dispatch work.
data "aws_iam_policy_document" "dispatch_from_events" {
  for_each = toset(local.departments)

  statement {
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dispatch[each.key].arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.route[each.key].arn]
    }
  }
}

resource "aws_sqs_queue_policy" "dispatch" {
  for_each  = toset(local.departments)
  queue_url = aws_sqs_queue.dispatch[each.key].id
  policy    = data.aws_iam_policy_document.dispatch_from_events[each.key].json
}

data "aws_iam_policy_document" "audit_from_sns" {
  statement {
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.audit.arn]

    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_sns_topic.notifications.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "audit" {
  queue_url = aws_sqs_queue.audit.id
  policy    = data.aws_iam_policy_document.audit_from_sns.json
}
