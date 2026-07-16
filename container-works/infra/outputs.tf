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
  value = aws_dynamodb_table.runs.name
}

output "cluster_name" {
  value = aws_ecs_cluster.works.name
}

output "task_family" {
  value = aws_ecs_task_definition.app.family
}

output "ecr_repo_url" {
  value = aws_ecr_repository.app.repository_url
}

output "ecr_repo_name" {
  value = aws_ecr_repository.app.name
}

output "build_project" {
  value = aws_codebuild_project.image.name
}

output "build_src_bucket" {
  value = aws_s3_bucket.build_src.bucket
}

output "app_log_group" {
  value = aws_cloudwatch_log_group.app.name
}

output "daily_schedule" {
  value = aws_scheduler_schedule.daily_report.name
}
