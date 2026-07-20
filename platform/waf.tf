# One shared edge ACL for the whole boardwalk. WAF pricing is per web ACL
# ($5/mo) + per rule ($1/mo) + $0.60/M requests — and a single CLOUDFRONT-scope
# ACL can be associated with EVERY distribution, so the entire portfolio rides
# one ~$8/mo ACL instead of $5+ per site. Each plank attaches it by data-source
# lookup (web_acl_id on the distribution); because every plank's API is served
# same-origin behind its CloudFront /api/* behavior, the ACL fronts the APIs too.
#
# Rule choices are deliberate:
#   - rate-limit-per-ip is the guardrail the app-layer caps can't provide: the
#     daily budgets on planks 6/7/11/12 are SHARED, so one hammering IP could
#     exhaust the demo for everyone (or keep plank 11's Aurora awake). 300
#     requests per 5 minutes is generous for a human, tight for a script.
#   - Amazon IP reputation + Known Bad Inputs (incl. Log4j lookups) are the
#     low-false-positive AWS managed groups, free beyond the $1/mo rule slot.
#   - The Core Rule Set is deliberately ABSENT: it pattern-matches request
#     bodies for SQL-ish content, and planks 11/12 legitimately carry SQL text
#     and free-form prompts in POST bodies. Blocking those would break the
#     exhibits the sites exist to show.
#   - No WAF logging (that is where WAF costs hide); free sampled requests +
#     CloudWatch metrics are plenty for a demo portfolio.

resource "aws_wafv2_web_acl" "edge" {
  name        = "platform-edge-acl"
  scope       = "CLOUDFRONT" # must live in us-east-1, which this root does
  description = "Shared boardwalk edge ACL: per-IP rate limit + AWS managed reputation/bad-input rules"

  default_action {
    allow {}
  }

  rule {
    name     = "rate-limit-per-ip"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 300 # per 5-minute window per IP
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "platform-edge-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-ip-reputation"
    priority = 2

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesAmazonIpReputationList"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "platform-edge-ip-reputation"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-known-bad-inputs"
    priority = 3

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "platform-edge-known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "platform-edge-acl"
    sampled_requests_enabled   = true
  }
}

output "web_acl_arn" {
  value = aws_wafv2_web_acl.edge.arn
}
