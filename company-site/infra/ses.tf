# SES identities for the contact form. The account is in the SES sandbox and
# stays there on purpose: mail only ever flows info@ → info@ (Reply-To carries
# the visitor's address), which the sandbox permits once info@ is verified.
#
# - Email identity info@planetek.org: creating it makes SES send a
#   verification mail to the iCloud inbox — the owner clicks the link once.
#   Covers both the From and To sides immediately, before any DNS cutover.
# - Domain identity planetek.org with DKIM: verifies automatically after the
#   nameserver cutover (the CNAMEs below live in the Route53 zone), which
#   gives DMARC-aligned signatures so form mail stops looking like spoof.

resource "aws_sesv2_email_identity" "contact" {
  email_identity = var.contact_email
}

resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.domain
}

resource "aws_route53_record" "ses_dkim" {
  count = 3

  zone_id = aws_route53_zone.apex.zone_id
  name    = "${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain}"
  type    = "CNAME"
  ttl     = 3600
  records = ["${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}
