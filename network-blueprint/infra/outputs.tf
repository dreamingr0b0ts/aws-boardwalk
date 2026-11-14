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
  description = "Direct HTTP API endpoint. Locked: only CloudFront's requests are served (see the origin lock in cloudfront.tf)"
  value       = aws_apigatewayv2_api.http.api_endpoint
}
