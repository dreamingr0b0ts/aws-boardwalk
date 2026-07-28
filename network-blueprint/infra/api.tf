resource "aws_apigatewayv2_api" "http" {
  name          = "${local.prefix}-api"
  protocol_type = "HTTP"
  description   = "Alpenglow Network Blueprint inspection API — served same-origin behind CloudFront /api/*"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  # Edge throttle in front of the round caps. A probe round costs nothing per
  # se (SSM Run Command is free), so like the containers plank this bounds
  # nuisance rather than spend; the DynamoDB lock + daily counter do the rest.
  default_route_settings {
    throttling_burst_limit = 10
    throttling_rate_limit  = 5
  }
}

# No authorizer on purpose: a round is free, one runs at a time, and the daily
# counter caps volume — the plank stays public like planks 3/4/5.
locals {
  routes = [
    "GET /api/status",
    "GET /api/runs",
    "GET /api/runs/{id}",
    "POST /api/runs",
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
