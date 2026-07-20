output "site_url" {
  value = var.custom_domain_enabled ? "https://${var.site_hostname}" : "https://${aws_cloudfront_distribution.site.domain_name}"
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
  value = aws_dynamodb_table.workbench.name
}

output "demo_email" {
  value = var.demo_email
}
