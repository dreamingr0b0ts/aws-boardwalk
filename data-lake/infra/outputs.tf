output "site_url" {
  value = var.custom_domain_enabled ? "https://${var.site_hostname}" : "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "site_bucket" {
  value = aws_s3_bucket.site.bucket
}

output "distribution_id" {
  value = aws_cloudfront_distribution.site.id
}

output "lake_bucket" {
  value = aws_s3_bucket.lake.bucket
}

output "glue_database" {
  value = aws_glue_catalog_database.lake.name
}

output "raw_table" {
  value = local.raw_table
}

output "curated_table" {
  value = local.curated_table
}

output "workgroup" {
  value = aws_athena_workgroup.public.name
}

output "etl_function" {
  value = aws_lambda_function.etl.function_name
}

output "raw_prefix" {
  value = local.raw_prefix
}

output "curated_prefix" {
  value = local.curated_prefix
}
