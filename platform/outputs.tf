output "zone_id" {
  description = "Hosted zone ID for demos.planetek.org"
  value       = aws_route53_zone.demos.zone_id
}

output "zone_name" {
  value = aws_route53_zone.demos.name
}

output "name_servers" {
  description = "Add these 4 NS records at GoDaddy for host 'demos'"
  value       = aws_route53_zone.demos.name_servers
}

output "certificate_arn" {
  description = "Wildcard cert (*.demos.planetek.org) — issues once delegation is live"
  value       = aws_acm_certificate.wildcard.arn
}
