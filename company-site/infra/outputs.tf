output "nameservers" {
  description = "Set these four as the domain's nameservers at GoDaddy to cut over"
  value       = aws_route53_zone.apex.name_servers
}

output "zone_id" {
  value = aws_route53_zone.apex.zone_id
}

output "cert_validation_records" {
  description = "Add these CNAMEs at GoDaddy BEFORE the NS cutover so the cert can issue"
  value = [
    for dvo in aws_acm_certificate.site.domain_validation_options : {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  ]
}

output "cert_arn" {
  value = aws_acm_certificate.site.arn
}

output "site_url" {
  value = var.custom_domain_enabled ? "https://${var.domain}" : "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "distribution_id" {
  value = aws_cloudfront_distribution.site.id
}

output "distribution_domain" {
  value = aws_cloudfront_distribution.site.domain_name
}

output "site_bucket" {
  value = aws_s3_bucket.site.bucket
}

output "api_endpoint" {
  value = aws_apigatewayv2_api.http.api_endpoint
}
