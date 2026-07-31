resource "aws_apigatewayv2_api" "http" {
  name          = "${local.prefix}-api"
  protocol_type = "HTTP"
  description   = "Alpenglow Security Posture exhibit API — served same-origin behind CloudFront /api/*"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  # Edge throttle in front of the exhibit caps. The policy desk and fence log
  # call free APIs and the drill is lock+counter gated, so like plank 9 this
  # bounds nuisance rather than spend.
  default_route_settings {
    throttling_burst_limit = 10
    throttling_rate_limit  = 5
  }
}

# No authorizer on purpose: every exhibit is free (IAM simulation, policy
# validation, WAF samples) or hard-capped (one drill at a time, 10/day), so
# the plank stays public like planks 3/4/5/9.
locals {
  routes = [
    "GET /api/status",
    "GET /api/drills",
    "GET /api/drills/{id}",
    "POST /api/drills",
    "POST /api/policy/simulate",
    "POST /api/policy/validate",
    "GET /api/fence",
  ]
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "all" {
  for_each  = toset(local.routes)
  api_id    = aws_apigatewayv2_api.http.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}
