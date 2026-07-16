# Custom-domain wiring. The demos.planetek.org zone and *.demos.planetek.org
# wildcard cert already exist (created by ../platform, delegated from GoDaddy),
# so custom_domain_enabled defaults to true for this plank.

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
