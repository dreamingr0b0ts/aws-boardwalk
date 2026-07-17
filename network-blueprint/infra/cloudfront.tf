locals {
  s3_origin_id = "site-s3"

  # AWS managed policy IDs (stable, documented constants)
  cache_optimized_id = "658327ea-f89d-4fab-a63d-7e88639e58f6" # CachingOptimized
  cache_disabled_id  = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
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
      # Everything is same-origin: the page fetches /evidence/*.json from its
      # own hostname, and the standalone evidence.html artifact carries inline
      # styles (style-src 'unsafe-inline' covers it).
      content_security_policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
      override                = true
    }
  }
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "Alpenglow Network Blueprint (aws-boardwalk / network-blueprint)"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  http_version        = "http2and3"

  aliases = var.custom_domain_enabled ? [var.site_hostname] : []

  origin {
    origin_id                = local.s3_origin_id
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id           = local.s3_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.cache_optimized_id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  # Evidence artifacts change on every demo cycle (report Lambda writes them,
  # make teardown updates status.json) — never cache them.
  ordered_cache_behavior {
    path_pattern               = "/evidence/*"
    target_origin_id           = local.s3_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.cache_disabled_id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.custom_domain_enabled ? null : true
    acm_certificate_arn            = var.custom_domain_enabled ? one(data.aws_acm_certificate.wildcard[*].arn) : null
    ssl_support_method             = var.custom_domain_enabled ? "sni-only" : null
    minimum_protocol_version       = var.custom_domain_enabled ? "TLSv1.2_2021" : "TLSv1"
  }
}
