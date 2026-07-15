resource "aws_apigatewayv2_api" "http" {
  name          = "${local.prefix}-api"
  protocol_type = "HTTP"
  description   = "Alpenglow Permits — served same-origin behind CloudFront /api/*"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  # Public demo hygiene: nobody gets to turn a free-tier stack into a bill.
  default_route_settings {
    throttling_burst_limit = 20
    throttling_rate_limit  = 10
  }
}

resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.http.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "cognito-jwt"

  jwt_configuration {
    issuer   = "https://cognito-idp.${local.region}.amazonaws.com/${aws_cognito_user_pool.users.id}"
    audience = [aws_cognito_user_pool_client.spa.id]
  }
}

locals {
  integrations = {
    public = aws_lambda_function.public
    me     = aws_lambda_function.me
    admin  = aws_lambda_function.admin
  }

  # route key => integration; me/admin routes require a valid Cognito JWT,
  # and the admin Lambda additionally enforces the admin group claim.
  routes = {
    "GET /api/public/permit-types"                = { fn = "public", auth = false }
    "GET /api/public/stats"                       = { fn = "public", auth = false }
    "GET /api/me/applications"                    = { fn = "me", auth = true }
    "POST /api/me/applications"                   = { fn = "me", auth = true }
    "GET /api/me/applications/{id}"               = { fn = "me", auth = true }
    "GET /api/admin/applications"                 = { fn = "admin", auth = true }
    "POST /api/admin/applications/{id}/decision"  = { fn = "admin", auth = true }
    "GET /api/admin/metrics"                      = { fn = "admin", auth = true }
    "GET /api/admin/permit-types"                 = { fn = "admin", auth = true }
    "POST /api/admin/permit-types"                = { fn = "admin", auth = true }
  }
}

resource "aws_apigatewayv2_integration" "lambda" {
  for_each               = local.integrations
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = each.value.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "all" {
  for_each  = local.routes
  api_id    = aws_apigatewayv2_api.http.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.lambda[each.value.fn].id}"

  authorization_type = each.value.auth ? "JWT" : "NONE"
  authorizer_id      = each.value.auth ? aws_apigatewayv2_authorizer.cognito.id : null
}

resource "aws_lambda_permission" "apigw" {
  for_each      = local.integrations
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = each.value.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}
