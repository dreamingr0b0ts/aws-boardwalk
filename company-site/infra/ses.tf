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

# ---- outbound-mail guardrails (added with the visitor-confirmation work) ----
# Every send (owner invite, visitor confirmation, contact relay) goes through
# this configuration set so reputation is tracked and every bounce, complaint,
# or rejection lands in the info@ inbox via SNS. The account-level suppression
# list (BOUNCE + COMPLAINT) stays on, so a dead address is never mailed twice.

resource "aws_sesv2_configuration_set" "mail" {
  configuration_set_name = "${local.prefix}-mail"

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }
}

resource "aws_sns_topic" "mail_events" {
  name = "${local.prefix}-mail-events"
}

# The owner must click the confirmation link SNS mails to info@ once.
resource "aws_sns_topic_subscription" "mail_events_email" {
  topic_arn = aws_sns_topic.mail_events.arn
  protocol  = "email"
  endpoint  = var.contact_email
}

resource "aws_sesv2_configuration_set_event_destination" "mail_events" {
  configuration_set_name = aws_sesv2_configuration_set.mail.configuration_set_name
  event_destination_name = "problems-to-inbox"

  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT", "REJECT"]

    sns_destination {
      topic_arn = aws_sns_topic.mail_events.arn
    }
  }
}
