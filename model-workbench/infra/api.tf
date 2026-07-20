resource "aws_apigatewayv2_api" "http" {
  name          = "${local.prefix}-api"
  protocol_type = "HTTP"
  description   = "Alpenglow Model Workbench — served same-origin behind CloudFront /api/*"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  # Every authenticated request can fan out to four Bedrock models, so the
  # edge throttle is the outermost of three cost guardrails
  # (edge throttle → per-user daily cap → global daily kill switch).
  default_route_settings {
    throttling_burst_limit = 10
    throttling_rate_limit  = 5
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
    run    = aws_lambda_function.run
  }

  # Every route that can reach Bedrock requires a valid Cognito JWT. The only
  # anonymous route serves the roster/scenario catalog and aggregate counters —
  # it cannot spend a token (its role has no bedrock permissions at all).
  routes = {
    "GET /api/public/info" = { fn = "public", auth = false }
    "POST /api/run"        = { fn = "run", auth = true }
    "GET /api/runs"        = { fn = "run", auth = true }
    "GET /api/me/quota"    = { fn = "run", auth = true }
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
