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

# Consumed by the demo root via terraform_remote_state: the response Lambda
# writes drill stages into the exhibits table, and the report Lambda simulates
# the (now always-on) boundary role.
output "exhibits_table" {
  value = aws_dynamodb_table.exhibits.name
}

output "exhibits_table_arn" {
  value = aws_dynamodb_table.exhibits.arn
}

output "boundary_role_arn" {
  value = aws_iam_role.boundary_demo.arn
}

output "boundary_role" {
  value = aws_iam_role.boundary_demo.name
}

