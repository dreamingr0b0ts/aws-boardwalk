resource "aws_apigatewayv2_api" "http" {
  name          = "${local.prefix}-api"
  protocol_type = "HTTP"
  description   = "Alpenglow Batch Works — served same-origin behind CloudFront /api/*"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  # Edge throttle in front of the launch caps. Reads are free-tier; launches
  # are additionally bounded by the DynamoDB daily counter + the 1-task
  # concurrency gate, so this bounds nuisance rather than spend.
  default_route_settings {
    throttling_burst_limit = 10
    throttling_rate_limit  = 5
  }
}

# No authorizer on purpose: a launch costs ~$0.001 and the concurrency gate +
# daily counter cap the worst case at pocket change, so the plank stays
# public like planks 1/3/5 rather than credential-gated like 6/7.
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
