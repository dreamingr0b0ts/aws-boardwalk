output "site_url" {
  value = var.custom_domain_enabled ? "https://${var.site_hostname}" : "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "site_bucket" {
  value = aws_s3_bucket.site.bucket
}

output "distribution_id" {
  value = aws_cloudfront_distribution.site.id
}

output "rest_api_id" {
  value = aws_api_gateway_rest_api.api.id
}

output "stage_invoke_url" {
  value = aws_api_gateway_stage.live.invoke_url
}

# Public by design (printed on the docs page at publish time — nothing behind
# it costs real money and its usage plan bounds nuisance). Marked sensitive
# anyway so it never lands in CI logs via a plan/apply diff.
output "demo_api_key" {
  value     = aws_api_gateway_api_key.demo.value
  sensitive = true
}

# Never distributed; verify.sh reads it to prove the partner tier works.
output "partner_api_key" {
  value     = aws_api_gateway_api_key.partner.value
  sensitive = true
}

output "permits_table" {
  value = aws_dynamodb_table.permits.name
}

output "licenses_table" {
  value = aws_dynamodb_table.licenses.name
}

output "facilities_table" {
  value = aws_dynamodb_table.facilities.name
}
