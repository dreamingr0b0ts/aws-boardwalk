# The event mesh itself: one custom bus, five rules. Three rules do
# content-based routing on detail.category (each to its own department queue),
# one fans every request out through SNS, and one starts the Step Functions
# escalation for urgent requests. The same event can match several rules —
# that decoupling IS the demo.

resource "aws_cloudwatch_event_bus" "mesh" {
  name = "${local.prefix}-bus"
}

locals {
  event_source = "alpenglow.dispatch"
  departments  = ["roads", "utilities", "parks"]
}

# --- content-based routing: detail.category -> department queue --------------

resource "aws_cloudwatch_event_rule" "route" {
  for_each       = toset(local.departments)
  name           = "${local.prefix}-route-${each.key}"
  description    = "Service requests for the ${each.key} department"
  event_bus_name = aws_cloudwatch_event_bus.mesh.name

  event_pattern = jsonencode({
    source = [local.event_source]
    detail = { category = [each.key] }
  })
}

resource "aws_cloudwatch_event_target" "route" {
  for_each       = toset(local.departments)
  rule           = aws_cloudwatch_event_rule.route[each.key].name
  event_bus_name = aws_cloudwatch_event_bus.mesh.name
  arn            = aws_sqs_queue.dispatch[each.key].arn
}

# --- pub/sub fan-out: every request -> SNS -> two subscriber types -----------

resource "aws_cloudwatch_event_rule" "notify_all" {
  name           = "${local.prefix}-notify-all"
  description    = "Every service request fans out through SNS"
  event_bus_name = aws_cloudwatch_event_bus.mesh.name

  event_pattern = jsonencode({
    source = [local.event_source]
  })
}

resource "aws_cloudwatch_event_target" "notify_all" {
  rule           = aws_cloudwatch_event_rule.notify_all.name
  event_bus_name = aws_cloudwatch_event_bus.mesh.name
  arn            = aws_sns_topic.notifications.arn
}

# --- orchestration: detail.priority = urgent -> Step Functions ---------------

resource "aws_cloudwatch_event_rule" "escalate_urgent" {
  name           = "${local.prefix}-escalate-urgent"
  description    = "Urgent requests start the escalation workflow"
  event_bus_name = aws_cloudwatch_event_bus.mesh.name

  event_pattern = jsonencode({
    source = [local.event_source]
    detail = { priority = ["urgent"] }
  })
}

resource "aws_cloudwatch_event_target" "escalate_urgent" {
  rule           = aws_cloudwatch_event_rule.escalate_urgent.name
  event_bus_name = aws_cloudwatch_event_bus.mesh.name
  arn            = aws_sfn_state_machine.escalation.arn
  role_arn       = aws_iam_role.events_to_sfn.arn
}

# --- heartbeat: Scheduler puts a synthetic request on the bus ----------------
# No Lambda involved: EventBridge Scheduler's templated PutEvents target
# publishes straight to the custom bus, so the dashboard always has a recent
# event flowing even with zero visitors. ~48 events/day, all free-tier.

resource "aws_scheduler_schedule" "heartbeat" {
  name        = "${local.prefix}-heartbeat"
  description = "Synthetic service request so the live dashboard never looks dead"

  schedule_expression = var.heartbeat_rate

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_cloudwatch_event_bus.mesh.arn
    role_arn = aws_iam_role.scheduler.arn

    eventbridge_parameters {
      detail_type = "service.request.submitted"
      source      = local.event_source
    }

    # No requestId on purpose: Scheduler does NOT substitute context
    # attributes inside EventBridge-target inputs (verified live — the
    # placeholder arrives literally), so consumers fall back to the
    # EventBridge envelope's own unique event id.
    input = jsonencode({
      category    = "parks"
      priority    = "normal"
      description = "Scheduled heartbeat: automated trail-inspection request"
      simulate    = "none"
      origin      = "heartbeat"
    })
  }
}

# --- nightly broom (09:00 UTC, the boardwalk's shared reset hour) ------------

resource "aws_cloudwatch_event_rule" "nightly_reset" {
  name                = "${local.prefix}-nightly-reset"
  description         = "Purge trace records and dead-letter queues"
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
