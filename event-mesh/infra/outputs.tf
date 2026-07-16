output "site_url" {
  value = var.custom_domain_enabled ? "https://${var.site_hostname}" : "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "site_bucket" {
  value = aws_s3_bucket.site.bucket
}

output "distribution_id" {
  value = aws_cloudfront_distribution.site.id
}

output "api_endpoint" {
  value = aws_apigatewayv2_api.http.api_endpoint
}

output "table_name" {
  value = aws_dynamodb_table.events.name
}

output "bus_name" {
  value = aws_cloudwatch_event_bus.mesh.name
}

output "state_machine_arn" {
  value = aws_sfn_state_machine.escalation.arn
}

output "heartbeat_schedule" {
  value = aws_scheduler_schedule.heartbeat.name
}

output "reset_function" {
  value = aws_lambda_function.reset.function_name
}

output "dispatch_queue_urls" {
  value = { for d in local.departments : d => aws_sqs_queue.dispatch[d].url }
}

output "dlq_urls" {
  value = { for d in local.departments : d => aws_sqs_queue.dlq[d].url }
}
