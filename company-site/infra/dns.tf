# Route53 hosted zone for the company apex domain.
#
# planetek.org's DNS is moving here from GoDaddy (registration stays at
# GoDaddy; only nameservers change). Every record that existed in the GoDaddy
# zone as of 2026-07-17 is replicated below so the NS cutover is a no-op for
# email (iCloud custom domain) and existing subdomains. The zone must be live
# and the ACM cert ISSUED before the owner flips nameservers at GoDaddy.

resource "aws_route53_zone" "apex" {
  name    = var.domain
  comment = "planetek.org company zone (aws-boardwalk / company-site)"

  # Mail for info@planetek.org rides on this zone. Never destroy it.
  lifecycle {
    prevent_destroy = true
  }
}

# --- iCloud custom-domain mail (replicated from GoDaddy verbatim) -----------

resource "aws_route53_record" "mx" {
  zone_id = aws_route53_zone.apex.zone_id
  name    = var.domain
  type    = "MX"
  ttl     = 3600
  records = [
    "10 mx01.mail.icloud.com.",
    "10 mx02.mail.icloud.com.",
  ]
}

resource "aws_route53_record" "apex_txt" {
  zone_id = aws_route53_zone.apex.zone_id
  name    = var.domain
  type    = "TXT"
  ttl     = 3600
  records = [
    "v=spf1 include:icloud.com ~all",
    "apple-domain=lsqSZ7wrN9xZTCjM",
    "google-site-verification=9JLtrNM4ZWFCi2BqNZCvbXr-vn460L_0FY69RoViMPs",
  ]
}

resource "aws_route53_record" "icloud_dkim" {
  zone_id = aws_route53_zone.apex.zone_id
  name    = "sig1._domainkey.${var.domain}"
  type    = "CNAME"
  ttl     = 3600
  records = ["sig1.dkim.planetek.org.at.icloudmailadmin.com."]
}

# GoDaddy's record pointed rua at their own collector (onsecureserver.net);
# reports now come to us instead — no external-destination authorization needed.
resource "aws_route53_record" "dmarc" {
  zone_id = aws_route53_zone.apex.zone_id
  name    = "_dmarc.${var.domain}"
  type    = "TXT"
  ttl     = 3600
  records = ["v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:${var.contact_email};"]
}

# --- demos.planetek.org delegation (the boardwalk zone, created by platform/)

data "aws_route53_zone" "demos" {
  name = "demos.${var.domain}"
}

resource "aws_route53_record" "demos_delegation" {
  zone_id = aws_route53_zone.apex.zone_id
  name    = "demos.${var.domain}"
  type    = "NS"
  ttl     = 3600
  records = data.aws_route53_zone.demos.name_servers
}

# --- the new site -----------------------------------------------------------
# Harmless before the NS cutover (this zone isn't authoritative yet), and by
# cutover time the distribution has the aliases attached.

locals {
  site_records = toset(["apex", "www"])
}

resource "aws_route53_record" "site_a" {
  for_each = local.site_records
  zone_id  = aws_route53_zone.apex.zone_id
  name     = each.key == "apex" ? var.domain : local.www_domain
  type     = "A"

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "site_aaaa" {
  for_each = local.site_records
  zone_id  = aws_route53_zone.apex.zone_id
  name     = each.key == "apex" ? var.domain : local.www_domain
  type     = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}
