# TLS cert for planetek.org + www. DNS-validated.
#
# Chicken-and-egg: the validation CNAMEs below live in the Route53 zone, but
# GoDaddy's nameservers stay authoritative until the owner cuts over — so the
# same CNAME must ALSO be added at GoDaddy once (make outputs prints it).
# There is deliberately no aws_acm_certificate_validation resource: it would
# block every apply until the owner does that step. scripts/verify.sh checks
# the cert status instead, and custom_domain_enabled stays false until ISSUED.

resource "aws_acm_certificate" "site" {
  domain_name               = var.domain
  subject_alternative_names = [local.www_domain]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.site.domain_validation_options : dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  }

  zone_id         = aws_route53_zone.apex.zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 300
  records         = [each.value.value]
  allow_overwrite = true
}
