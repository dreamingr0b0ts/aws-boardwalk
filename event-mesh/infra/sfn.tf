# The escalation workflow for urgent requests — EXPRESS type on purpose:
# a short synchronous-ish flow like this costs ~nothing per million requests
# (standard workflows would burn the 4k free transitions in ~600 runs).
#
# Dispatch deliberately throws a transient error on its first attempt for
# every urgent request, so the trace ALWAYS shows a real retry-with-backoff —
# deterministic for demos and for verify.sh, no dice-rolling.

resource "aws_cloudwatch_log_group" "escalation" {
  name              = "/aws/vendedlogs/states/${local.prefix}-escalation"
  retention_in_days = 14
}

resource "aws_sfn_state_machine" "escalation" {
  name     = "${local.prefix}-escalation"
  type     = "EXPRESS"
  role_arn = aws_iam_role.escalation.arn

  tracing_configuration {
    enabled = true # X-Ray, consistent with every Lambda in the boardwalk
  }

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.escalation.arn}:*"
    include_execution_data = false
    level                  = "ERROR"
  }

  definition = jsonencode({
    Comment        = "Urgent service request escalation: triage -> dispatch (retries a simulated transient fault) -> resolve"
    StartAt        = "Triage"
    TimeoutSeconds = 120

    States = {
      Triage = {
        Type     = "Task"
        Resource = aws_lambda_function.escalate.arn
        Parameters = {
          action     = "triage"
          "detail.$" = "$.detail"
        }
        ResultPath = null # pass the original event through unchanged
        Catch      = local.catch_to_failed
        Next       = "DispatchCrew"
      }

      DispatchCrew = {
        Type     = "Task"
        Resource = aws_lambda_function.escalate.arn
        Parameters = {
          action     = "dispatch"
          "detail.$" = "$.detail"
        }
        ResultPath = null
        Retry = [{
          ErrorEquals     = ["TransientDispatchError"]
          IntervalSeconds = 3
          MaxAttempts     = 2
          BackoffRate     = 2
        }]
        Catch = local.catch_to_failed
        Next  = "Resolve"
      }

      Resolve = {
        Type     = "Task"
        Resource = aws_lambda_function.escalate.arn
        Parameters = {
          action     = "resolve"
          "detail.$" = "$.detail"
        }
        ResultPath = null
        Catch      = local.catch_to_failed
        End        = true
      }

      # Direct DynamoDB integration (no Lambda): flip the escalation field so
      # the dashboard never shows an urgent request stuck "in progress".
      MarkEscalationFailed = {
        Type     = "Task"
        Resource = "arn:aws:states:::dynamodb:updateItem"
        Parameters = {
          TableName = aws_dynamodb_table.events.name
          Key = {
            PK = { "S.$" = "States.Format('REQ#{}', $$.Execution.Input.detail.requestId)" }
            SK = { S = "META" }
          }
          UpdateExpression         = "SET #e = :failed"
          ExpressionAttributeNames = { "#e" = "escalation" }
          ExpressionAttributeValues = {
            ":failed" = { S = "failed" }
          }
        }
        Next = "EscalationFailed"
      }

      EscalationFailed = {
        Type  = "Fail"
        Error = "EscalationFailed"
        Cause = "A workflow stage failed; the request trace has the detail."
      }
    }
  })
}

locals {
  catch_to_failed = [{
    ErrorEquals = ["States.ALL"]
    ResultPath  = "$.error"
    Next        = "MarkEscalationFailed"
  }]
}
