# Custom-domain wiring, gated behind var.custom_domain_enabled so the plank
# deploys fully (on the default CloudFront hostname) before the GoDaddy NS
# delegation is live. Flip the flag once `aws acm describe-certificate` shows
# ISSUED — the data source below intentionally fails otherwise.

data "aws_route53_zone" "demos" {
  count = var.custom_domain_enabled ? 1 : 0
  name  = var.zone_name
}

data "aws_acm_certificate" "wildcard" {
  count    = var.custom_domain_enabled ? 1 : 0
  domain   = "*.${var.zone_name}"
  statuses = ["ISSUED"]
}

resource "aws_route53_record" "site_a" {
  count   = var.custom_domain_enabled ? 1 : 0
  zone_id = one(data.aws_route53_zone.demos[*].zone_id)
  name    = var.site_hostname
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "site_aaaa" {
  count   = var.custom_domain_enabled ? 1 : 0
  zone_id = one(data.aws_route53_zone.demos[*].zone_id)
  name    = var.site_hostname
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}
