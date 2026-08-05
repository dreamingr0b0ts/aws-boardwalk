# ── The practice-smoke drill (visitor-triggered detect-and-respond) ──────────
# A visitor lights a safe, controlled misconfiguration and watches the account
# catch and remediate it live. Everything billable here is Config evaluations
# (pennies), so it lives in the demo root and is torn down with the season.
#
# The staging target is a security group in a dedicated, inert VPC: no subnets,
# no internet gateway, no attached ENI. Opening port 22 on it exposes nothing.
# The drill's whole value is the detection→response→audit loop it exercises,
# not any real exposure.
#
# Two independent detectors watch the same group:
#   • the TRIPWIRE — an EventBridge rule on the CloudTrail
#     AuthorizeSecurityGroupIngress event fires the response Lambda, which
#     revokes the rule automatically (event-driven, fast).
#   • the INSPECTOR — an AWS Config restricted-ssh managed rule rules on the
#     group on its own periodic/change cadence (compliance, slower).
# The always-on runner Lambda (../infra) narrates both and times the tripwire.

# ---- the inert sandbox ------------------------------------------------------

resource "aws_vpc" "sandbox" {
  # checkov:skip=CKV2_AWS_11:flow logs on an inert, routeless VPC with no ENI would log nothing
  # checkov:skip=CKV2_AWS_12:default SG is left default; the drill uses a dedicated tagged group
  cidr_block = "10.99.0.0/16"

  # No IGW, no subnets, no routes: nothing in here can reach or be reached.
  tags = { Name = "${local.prefix}-drill-sandbox" }
}

# The group the drill opens and the detectors close. Bare on purpose: no
# ingress is declared, so the runtime rule the drill adds (and the tripwire
# removes) never fights Terraform. revoke_rules_on_delete sweeps any lingering
# runtime rule at teardown. The exhibit=practice-smoke tag is the fence: the
# runner may only authorize, and the responder may only revoke, on THIS group.
# checkov:skip=CKV2_AWS_5 attached to nothing on purpose: opening a rule on an SG with no ENI exposes nothing; that inertness is the whole safety of the exhibit
resource "aws_security_group" "sandbox" {
  name                   = "${local.prefix}-drill-sandbox"
  description            = "Practice-smoke drill target: opened and re-closed by the detect-and-respond exhibit. Attached to nothing."
  vpc_id                 = aws_vpc.sandbox.id
  revoke_rules_on_delete = true

  tags = { Name = "${local.prefix}-drill-sandbox", exhibit = "practice-smoke" }
}

# ---- the inspector: AWS Config restricted-ssh, scoped to the sandbox --------

resource "aws_config_config_rule" "restricted_ssh" {
  name        = "${local.prefix}-drill-restricted-ssh"
  description = "Practice-smoke inspector: flags the sandbox group NON_COMPLIANT while it allows unrestricted SSH."

  source {
    owner             = "AWS"
    source_identifier = "INCOMING_SSH_DISABLED"
  }

  # Evaluate only the tagged sandbox group, not every SG in the account.
  scope {
    tag_key   = "exhibit"
    tag_value = "practice-smoke"
  }

  depends_on = [aws_config_configuration_recorder_status.main]
}

# ---- the tripwire: EventBridge on the CloudTrail authorize event ------------

data "archive_file" "responder" {
  type        = "zip"
  source_file = "${path.module}/lambda/response.mjs"
  output_path = "${path.module}/lambda/response.zip"
}

resource "aws_iam_role" "responder" {
  name = "${local.prefix}-drill-responder"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "responder" {
  name = "revoke-the-smoke"
  role = aws_iam_role.responder.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # The response may revoke ingress ONLY on the tagged sandbox group.
        Sid      = "RevokeOnlyTheSandbox"
        Effect   = "Allow"
        Action   = "ec2:RevokeSecurityGroupIngress"
        Resource = "arn:aws:ec2:${local.region}:${local.account_id}:security-group/*"
        Condition = {
          StringEquals = { "ec2:ResourceTag/exhibit" = "practice-smoke" }
        }
      },
      {
        Sid      = "SeeTheSmoke"
        Effect   = "Allow"
        Action   = "ec2:DescribeSecurityGroups"
        Resource = "*" # EC2 Describe* calls support no resource-level scoping
      },
      {
        Sid      = "OwnLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/${local.prefix}-drill-responder*"
      }
    ]
  })
}

resource "aws_lambda_function" "responder" {
  function_name    = "${local.prefix}-drill-responder"
  role             = aws_iam_role.responder.arn
  runtime          = "nodejs22.x"
  handler          = "response.handler"
  architectures    = ["arm64"]
  filename         = data.archive_file.responder.output_path
  source_code_hash = data.archive_file.responder.output_base64sha256
  timeout          = 30
  memory_size      = 256

  environment {
    variables = {
      SANDBOX_SG_ID = aws_security_group.sandbox.id
    }
  }

  tracing_config {
    mode = "Active"
  }
}

resource "aws_cloudwatch_event_rule" "authorize" {
  name        = "${local.prefix}-drill-tripwire"
  description = "Fires the response Lambda when the sandbox group's ingress is opened."

  # AuthorizeSecurityGroupIngress arrives at EventBridge via CloudTrail (the
  # multi-region demo trail is what delivers it), filtered to the sandbox group.
  event_pattern = jsonencode({
    source      = ["aws.ec2"]
    detail-type = ["AWS API Call via CloudTrail"]
    detail = {
      eventSource = ["ec2.amazonaws.com"]
      eventName   = ["AuthorizeSecurityGroupIngress"]
      requestParameters = {
        groupId = [aws_security_group.sandbox.id]
      }
    }
  })
}

resource "aws_cloudwatch_event_target" "responder" {
  rule      = aws_cloudwatch_event_rule.authorize.name
  target_id = "responder"
  arn       = aws_lambda_function.responder.arn
}

resource "aws_lambda_permission" "eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.responder.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.authorize.arn
}

# ---- discovery handshake for the always-on runner ---------------------------
# The runner (../infra) reads these while the stack is deployed; they are
# destroyed with it, so the exhibit API answers 503 honestly between windows.

resource "aws_ssm_parameter" "sandbox_sg_id" {
  name  = "${local.ssm_prefix}/sandbox-sg-id"
  type  = "SecureString"
  value = aws_security_group.sandbox.id
}

resource "aws_ssm_parameter" "config_rule_name" {
  name  = "${local.ssm_prefix}/config-rule-name"
  type  = "SecureString"
  value = aws_config_config_rule.restricted_ssh.name
}

resource "aws_ssm_parameter" "hold_seconds" {
  name        = "${local.ssm_prefix}/hold-seconds"
  type        = "SecureString"
  description = "How long the runner watches for the tripwire before its failsafe revoke."
  value       = "300"
}

locals {
  ssm_prefix = "/boardwalk/security-posture"
}

output "sandbox_sg_id" {
  value = aws_security_group.sandbox.id
}

output "drill_config_rule" {
  value = aws_config_config_rule.restricted_ssh.name
}

output "responder_function" {
  value = aws_lambda_function.responder.function_name
}
