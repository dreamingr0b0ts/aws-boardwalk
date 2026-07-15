locals {
  s3_origin_id  = "site-s3"
  api_origin_id = "http-api"
  api_domain    = replace(aws_apigatewayv2_api.http.api_endpoint, "https://", "")

  # AWS managed policy IDs (stable, documented constants)
  cache_optimized_id    = "658327ea-f89d-4fab-a63d-7e88639e58f6" # CachingOptimized
  cache_disabled_id     = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
  origin_all_viewer_ehh = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # AllViewerExceptHostHeader
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
      # connect-src includes Cognito (sign-in) and the docs bucket (the
      # browser's presigned POST goes straight to S3, bypassing the API).
      content_security_policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://cognito-idp.${local.region}.amazonaws.com https://${aws_s3_bucket.docs.bucket_regional_domain_name} https://s3.${local.region}.amazonaws.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
      override                = true
    }
  }

  # Belt-and-suspenders with robots.txt: keep the upload surface out of
  # search indexes, same posture as plank 6.
  custom_headers_config {
    items {
      header   = "X-Robots-Tag"
      value    = "noindex, nofollow"
      override = true
    }
  }
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "Alpenglow Document Intelligence (aws-boardwalk / doc-processing)"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  http_version        = "http2and3"

  aliases = var.custom_domain_enabled ? [var.site_hostname] : []

  origin {
    origin_id                = local.s3_origin_id
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  origin {
    origin_id   = local.api_origin_id
    domain_name = local.api_domain

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
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

  # Same-origin API: the page calls /api/* on its own hostname — no CORS
  # anywhere. Host header must NOT be forwarded or API Gateway can't route.
  ordered_cache_behavior {
    path_pattern               = "/api/*"
    target_origin_id           = local.api_origin_id
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.cache_disabled_id
    origin_request_policy_id   = local.origin_all_viewer_ehh
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
