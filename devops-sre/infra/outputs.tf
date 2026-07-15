output "site_url" {
  description = "Ops status page"
  value       = var.custom_domain_enabled ? "https://${var.site_hostname}" : "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "cloudfront_domain" {
  value = aws_cloudfront_distribution.site.domain_name
}

output "distribution_id" {
  value = aws_cloudfront_distribution.site.id
}

output "site_bucket" {
  value = aws_s3_bucket.site.bucket
}

output "gh_plan_role_arn" {
  description = "Assumed by GitHub Actions for PR plans (read-only)"
  value       = aws_iam_role.gh_plan.arn
}

output "gh_apply_role_arn" {
  description = "Assumed by GitHub Actions applies through the prod environment"
  value       = aws_iam_role.gh_apply.arn
}

output "dashboard_url" {
  value = "https://${local.region}.console.aws.amazon.com/cloudwatch/home?region=${local.region}#dashboards/dashboard/${aws_cloudwatch_dashboard.boardwalk.dashboard_name}"
}

output "canary_name" {
  value = aws_synthetics_canary.heartbeat.name
}

output "runbook_state_machine_arn" {
  value = aws_sfn_state_machine.runbook.arn
}

output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}
