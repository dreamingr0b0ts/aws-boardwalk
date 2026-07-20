output "site_bucket" {
  value = aws_s3_bucket.site.id
}

output "site_bucket_arn" {
  value = aws_s3_bucket.site.arn
}

output "distribution_id" {
  value = aws_cloudfront_distribution.site.id
}

output "site_url" {
  value = var.custom_domain_enabled ? "https://${var.site_hostname}" : "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "api_endpoint" {
  description = "Direct HTTP API endpoint (also reachable same-origin at <site>/api)"
  value       = aws_apigatewayv2_api.http.api_endpoint
}

output "table_name" {
  value = aws_dynamodb_table.registry.name
}
