# Shared DNS + TLS for the whole boardwalk.
#
# planetek.org is registered at GoDaddy; only this subdomain is delegated to
# Route53 (4 NS records added at the registrar). The wildcard certificate
# covers the Demo Hub and every plank site, so no other plank ever needs to
# touch ACM or create a zone.

resource "aws_route53_zone" "demos" {
  name    = var.zone_name
  comment = "AWS Boardwalk demo environments (delegated from GoDaddy)"

  # Destroying the zone would rotate its NS records and break the
  # registrar-side delegation. Never let a stray destroy take it out.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_acm_certificate" "wildcard" {
  domain_name               = "*.${var.zone_name}"
  subject_alternative_names = [var.zone_name]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# Validation CNAMEs live in the zone from day one; ACM auto-issues the moment
# the registrar delegation goes live. No blocking waiter here on purpose —
# planks that attach the cert check its status themselves.
# Keyed by domain_name (known at plan time); the wildcard and apex share one
# validation record, hence allow_overwrite.
resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.wildcard.domain_validation_options :
    dvo.domain_name => {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  }

  zone_id         = aws_route53_zone.demos.zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 300
  records         = [each.value.value]
  allow_overwrite = true
}
