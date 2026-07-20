# Ops status page — same private-S3 + CloudFront-OAC pattern as every plank.
# The page shows the pipeline (live GitHub badges), the latest backup/restore
# drill report (runbook/latest.json, written by the runbook Lambda), and how
# the observability pieces fit together.

resource "aws_s3_bucket" "site" {
  bucket        = "${local.prefix}-site-${local.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket = aws_s3_bucket.site.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "site_oac" {
  bucket = aws_s3_bucket.site.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontOAC"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.site.arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.site.arn
        }
      }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.site]
}

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${local.prefix}-site-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_response_headers_policy" "security" {
  name = "${local.prefix}-security-headers"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    content_security_policy {
      # Inline script fetches runbook/latest.json (same-origin); workflow
      # status badges are served by github.com.
      content_security_policy = "default-src 'self'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://github.com; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
      override                = true
    }
  }
}

# The shared boardwalk edge ACL (rate limit + AWS managed rules) lives in
# ../platform and is attached to every distribution — one ~$8/mo ACL for the
# whole portfolio. Deploy platform first; this lookup fails without it.
data "aws_wafv2_web_acl" "edge" {
  name  = "platform-edge-acl"
  scope = "CLOUDFRONT"
}

resource "aws_cloudfront_distribution" "site" {
  web_acl_id = data.aws_wafv2_web_acl.edge.arn

  enabled             = true
  is_ipv6_enabled     = true
  comment             = "Boardwalk ops status page (aws-boardwalk / devops-sre)"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  http_version        = "http2and3"

  aliases = var.custom_domain_enabled ? [var.site_hostname] : []

  origin {
    origin_id                = "site-s3"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id           = "site-s3"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = "658327ea-f89d-4fab-a63d-7e88639e58f6" # CachingOptimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }
  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  dynamic "viewer_certificate" {
    for_each = var.custom_domain_enabled ? [1] : []
    content {
      acm_certificate_arn      = data.aws_acm_certificate.wildcard[0].arn
      ssl_support_method       = "sni-only"
      minimum_protocol_version = "TLSv1.2_2021"
    }
  }

  dynamic "viewer_certificate" {
    for_each = var.custom_domain_enabled ? [] : [1]
    content {
      cloudfront_default_certificate = true
    }
  }
}

# --- DNS -----------------------------------------------------------------------

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
  zone_id = data.aws_route53_zone.demos[0].zone_id
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
  zone_id = data.aws_route53_zone.demos[0].zone_id
  name    = var.site_hostname
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}
