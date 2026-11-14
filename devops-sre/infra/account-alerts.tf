# Tripwires on the account's own record: a handful of events that should
# never happen quietly, mailed to the alerts topic the alarms already use.
#
# EventBridge matches management events as CloudTrail records them (this needs
# the trail in account-baseline.tf to be logging) and publishes a one-line
# summary to SNS. Rules, matching and the first 1,000 emails a month are free.
#
# Everything here is rare by construction. Nothing automated in this account
# signs in as root, creates a user or a key, edits the CI roles, or changes
# the Organization, so each mail is either the owner's own work arriving as a
# receipt or something that needs looking at now.
#
# Region: us-east-1 only. IAM, Organizations and root sign-in are global
# services recorded here, and the trail, analyzer and rules live here too.

# The topic keeps the policy it had by default (anything in this account may
# publish, which is how the CloudWatch alarms reach it) and gains one
# statement for the rules below.
resource "aws_sns_topic_policy" "alerts" {
  arn = aws_sns_topic.alerts.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Id      = "__default_policy_ID"
    Statement = [
      {
        Sid       = "__default_statement_ID"
        Effect    = "Allow"
        Principal = { AWS = "*" }
        Action = [
          "SNS:GetTopicAttributes", "SNS:SetTopicAttributes", "SNS:AddPermission",
          "SNS:RemovePermission", "SNS:DeleteTopic", "SNS:Subscribe",
          "SNS:ListSubscriptionsByTopic", "SNS:Publish",
        ]
        Resource  = aws_sns_topic.alerts.arn
        Condition = { StringEquals = { "AWS:SourceOwner" = local.account_id } }
      },
      {
        Sid       = "AccountAlertRules"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = "sns:Publish"
        Resource  = aws_sns_topic.alerts.arn
        Condition = { ArnLike = { "aws:SourceArn" = "arn:aws:events:${local.region}:${local.account_id}:rule/${local.prefix}-alert-*" } }
      },
    ]
  })
}

locals {
  ci_role_prefix = "${local.prefix}-gh-"

  # Patterns are stored encoded so the map's values share one type.
  alert_rules = {
    # The root user has no reason to be used day to day. Calls AWS services
    # make on the account's behalf also carry the Root identity; those are
    # excluded.
    root-activity = {
      description = "The root user signed in or made an API call"
      pattern = jsonencode({
        "detail-type" = ["AWS API Call via CloudTrail", "AWS Console Sign In via CloudTrail"]
        detail = {
          userIdentity = { type = ["Root"], invokedBy = [{ exists = false }] }
          eventType    = [{ "anything-but" = "AwsServiceEvent" }]
        }
      })
    }

    # New people, new long-lived credentials, weakened sign-in, new identity
    # providers. The pipeline cannot make any of these calls.
    identity-change = {
      description = "An IAM user, access key, console password, MFA device or identity provider was created or changed"
      pattern = jsonencode({
        "detail-type" = ["AWS API Call via CloudTrail"]
        detail = {
          eventSource = ["iam.amazonaws.com"]
          eventName = [
            "CreateUser", "CreateAccessKey", "UpdateAccessKey",
            "CreateLoginProfile", "UpdateLoginProfile",
            "AttachUserPolicy", "PutUserPolicy", "AddUserToGroup",
            "AttachGroupPolicy", "PutGroupPolicy",
            "DeactivateMFADevice", "DeleteVirtualMFADevice",
            "CreateOpenIDConnectProvider", "AddClientIDToOpenIDConnectProvider",
            "UpdateOpenIDConnectProviderThumbprint",
            "CreateSAMLProvider", "UpdateSAMLProvider",
          ]
        }
      })
    }

    # The CI roles and the two boundary policies decide what the pipeline, and
    # everything it creates, can do. Only the owner changes them, by hand.
    fence-change = {
      description = "A CI role or a permissions boundary was edited, or a boundary was taken off a role"
      pattern = jsonencode({
        "detail-type" = ["AWS API Call via CloudTrail"]
        detail = {
          eventSource = ["iam.amazonaws.com"]
          "$or" = [
            { eventName = ["DeleteRolePermissionsBoundary"] },
            {
              eventName = [
                "UpdateAssumeRolePolicy", "PutRolePolicy", "DeleteRolePolicy",
                "AttachRolePolicy", "DetachRolePolicy", "PutRolePermissionsBoundary",
                "DeleteRole",
              ]
              requestParameters = { roleName = [{ prefix = local.ci_role_prefix }] }
            },
            {
              eventName         = ["CreatePolicyVersion", "SetDefaultPolicyVersion", "DeletePolicy"]
              requestParameters = { policyArn = [local.role_boundary_arn, local.exhibit_boundary_arn] }
            },
          ]
        }
      })
    }

    # Someone switching off the record, or the tripwires that read it.
    audit-change = {
      description = "The audit trail, its bucket, the access analyzer, the account public access block or an alert rule was changed"
      pattern = jsonencode({
        "detail-type" = ["AWS API Call via CloudTrail"]
        detail = {
          "$or" = [
            {
              # This trail only, by name or ARN (callers may pass either):
              # plank 8 deletes its own demo trail at every teardown.
              eventSource       = ["cloudtrail.amazonaws.com"]
              eventName         = ["StopLogging", "DeleteTrail", "UpdateTrail", "PutEventSelectors"]
              requestParameters = { name = [local.audit_trail_name, local.audit_trail_arn] }
            },
            {
              eventSource = ["s3.amazonaws.com"]
              eventName = [
                "DeleteBucket", "PutBucketPolicy", "DeleteBucketPolicy",
                "PutBucketLifecycle", "DeleteBucketLifecycle", "PutBucketVersioning",
                "PutBucketPublicAccessBlock", "DeleteBucketPublicAccessBlock",
              ]
              requestParameters = { bucketName = [aws_s3_bucket.audit.bucket] }
            },
            {
              eventSource = ["s3.amazonaws.com"]
              eventName   = ["PutAccountPublicAccessBlock", "DeleteAccountPublicAccessBlock"]
            },
            {
              eventSource = ["access-analyzer.amazonaws.com"]
              eventName   = ["DeleteAnalyzer"]
            },
            {
              eventSource       = ["events.amazonaws.com"]
              eventName         = ["DeleteRule", "DisableRule"]
              requestParameters = { name = [{ prefix = "${local.prefix}-alert-" }] }
            },
            {
              eventSource       = ["events.amazonaws.com"]
              eventName         = ["RemoveTargets"]
              requestParameters = { rule = [{ prefix = "${local.prefix}-alert-" }] }
            },
          ]
        }
      })
    }

    # This is the management account: these calls create, invite, move or
    # remove whole accounts and set the policies that bind them. EventBridge
    # is only sent the calls that change something, so no read filter.
    organization-change = {
      description = "The AWS Organization was changed"
      pattern = jsonencode({
        source        = ["aws.organizations"]
        "detail-type" = ["AWS API Call via CloudTrail"]
      })
    }
  }
}

resource "aws_cloudwatch_event_rule" "alert" {
  for_each = local.alert_rules

  name          = "${local.prefix}-alert-${each.key}"
  description   = each.value.description
  event_pattern = each.value.pattern

  # The rules see nothing until the trail is logging. Waiting for it also
  # keeps the audit bucket's own first-time setup out of the owner's inbox.
  depends_on = [
    aws_cloudtrail.audit,
    aws_s3_bucket_lifecycle_configuration.audit,
    aws_s3_bucket_versioning.audit,
  ]
}

resource "aws_cloudwatch_event_target" "alert" {
  for_each = local.alert_rules

  rule = aws_cloudwatch_event_rule.alert[each.key].name
  arn  = aws_sns_topic.alerts.arn

  # One readable line instead of the raw event. The full record is in the
  # trail; this says which record to look for. A failed attempt matches too,
  # and its error code is the tell.
  input_transformer {
    input_paths = {
      event   = "$.detail.eventName"
      service = "$.detail.eventSource"
      who     = "$.detail.userIdentity.arn"
      ip      = "$.detail.sourceIPAddress"
      when    = "$.detail.eventTime"
      region  = "$.detail.awsRegion"
      error   = "$.detail.errorCode"
    }
    # Written as a literal: jsonencode() would escape the angle brackets.
    input_template = "\"Boardwalk account alert [${each.key}]: <event> on <service>, by <who>, from <ip>, at <when> in <region>. Error code (blank if the call succeeded): <error>. Why this is mailed: ${lower(substr(each.value.description, 0, 1))}${substr(each.value.description, 1, -1)}. The full record is in CloudTrail under that event name and time.\""
  }
}

# Access Analyzer speaks for itself rather than through CloudTrail: one event
# per finding when it is first seen or its status changes.
resource "aws_cloudwatch_event_rule" "access_finding" {
  name        = "${local.prefix}-alert-access-finding"
  description = "Access Analyzer found something in this account reachable from outside it"

  event_pattern = jsonencode({
    source        = ["aws.access-analyzer"]
    "detail-type" = ["Access Analyzer Finding"]
    detail        = { status = ["ACTIVE"] }
  })
}

resource "aws_cloudwatch_event_target" "access_finding" {
  rule = aws_cloudwatch_event_rule.access_finding.name
  arn  = aws_sns_topic.alerts.arn

  input_transformer {
    input_paths = {
      id       = "$.detail.id"
      kind     = "$.detail.resourceType"
      resource = "$.detail.resource"
      public   = "$.detail.isPublic"
    }
    input_template = "\"Boardwalk account alert [access-finding]: <kind> <resource> can be used from outside this account (open to anyone: <public>). Finding <id>. Review it in the IAM console under Access Analyzer.\""
  }
}
