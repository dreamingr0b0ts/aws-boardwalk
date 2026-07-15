output "site_url" {
  description = "Live site (default CloudFront hostname until the domain is flipped on)"
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

output "docs_bucket" {
  value = aws_s3_bucket.docs.bucket
}

output "api_endpoint" {
  description = "Direct HTTP API endpoint (also reachable same-origin at <site>/api)"
  value       = aws_apigatewayv2_api.http.api_endpoint
}

output "user_pool_id" {
  value = aws_cognito_user_pool.users.id
}

output "user_pool_client_id" {
  value = aws_cognito_user_pool_client.spa.id
}

output "table_name" {
  value = aws_dynamodb_table.documents.name
}

output "state_machine_arn" {
  value = aws_sfn_state_machine.pipeline.arn
}

output "reset_function" {
  value = aws_lambda_function.reset.function_name
}

output "demo_email" {
  value = var.demo_email
}
