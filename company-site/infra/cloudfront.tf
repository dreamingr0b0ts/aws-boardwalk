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
      # Site JS lives in /assets/site.js (script-src 'self'); inline <style>
      # needs style-src; the contact form posts same-origin to /api/contact.
      content_security_policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
      override                = true
    }
  }
}

# Viewer-request function: 301 www → apex, and clean URLs (/privacy → /privacy.html).
resource "aws_cloudfront_function" "router" {
  name    = "${local.prefix}-router"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = templatefile("${path.module}/cf-router.js.tftpl", { apex = var.domain })
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

  # checkov:skip=CKV_AWS_174: the default-cert block is the disabled branch of a dynamic block; the active branch pins TLSv1.2_2021
  # checkov:skip=CKV2_AWS_42: default cert only until the owner adds the ACM validation CNAMEs at GoDaddy; custom_domain_enabled then flips to true
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "Planetek company site (aws-boardwalk / company-site)"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  http_version        = "http2and3"

  aliases = var.custom_domain_enabled ? [var.domain, local.www_domain] : []

  origin {
    origin_id                = "site-s3"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  origin {
    origin_id   = "contact-api"
    domain_name = replace(aws_apigatewayv2_api.http.api_endpoint, "https://", "")

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id           = "site-s3"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = "658327ea-f89d-4fab-a63d-7e88639e58f6" # CachingOptimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.router.arn
    }
  }

  ordered_cache_behavior {
    path_pattern               = "/api/*"
    target_origin_id           = "contact-api"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
    origin_request_policy_id   = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # AllViewerExceptHostHeader
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  custom_error_response {
    error_code         = 403
    response_code      = 404
    response_page_path = "/404.html"
  }
  custom_error_response {
    error_code         = 404
    response_code      = 404
    response_page_path = "/404.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  dynamic "viewer_certificate" {
    for_each = var.custom_domain_enabled ? [1] : []
    content {
      acm_certificate_arn      = aws_acm_certificate.site.arn
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
