# Alarms → SNS → email. All alarms fit inside the 10-alarm free tier.
# The email subscription must be confirmed once (AWS sends a link).

resource "aws_sns_topic" "alerts" {
  name = "${local.prefix}-alerts"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  alarm_actions = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "mwa_api_5xx" {
  alarm_name          = "${local.prefix}-permits-api-5xx"
  alarm_description   = "Permits API returned 5 or more server errors in 5 minutes"
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  dimensions          = { ApiId = local.mwa_api_id }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "gai_chat_errors" {
  alarm_name          = "${local.prefix}-assistant-chat-errors"
  alarm_description   = "Assistant chat Lambda threw errors — every failed request is a bad demo moment"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = "gai-chat" }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "ddb_throttles" {
  alarm_name          = "${local.prefix}-permits-ddb-throttles"
  alarm_description   = "DynamoDB requests are being throttled on the permits table"
  namespace           = "AWS/DynamoDB"
  metric_name         = "ThrottledRequests"
  dimensions          = { TableName = local.mwa_table }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "canary_failed" {
  alarm_name          = "${local.prefix}-heartbeat-canary-failed"
  alarm_description   = "Synthetic heartbeat saw a plank down (only evaluates while the canary is started for a demo window)"
  namespace           = "CloudWatchSynthetics"
  metric_name         = "SuccessPercent"
  dimensions          = { CanaryName = aws_synthetics_canary.heartbeat.name }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 1
  threshold           = 100
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "drill_failed" {
  alarm_name          = "${local.prefix}-backup-drill-failed"
  alarm_description   = "The backup/restore drill did not complete cleanly — restores are unproven until it passes again"
  namespace           = "AWS/States"
  metric_name         = "ExecutionsFailed"
  dimensions          = { StateMachineArn = aws_sfn_state_machine.runbook.arn }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}
