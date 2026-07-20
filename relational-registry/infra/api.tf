resource "aws_apigatewayv2_api" "http" {
  name          = "${local.prefix}-api"
  protocol_type = "HTTP"
  description   = "Alpenglow Land & Records Registry — served same-origin behind CloudFront /api/*"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  # Exhibits are canned read-mostly SQL, so a request costs nothing per se —
  # but every request keeps the auto-pause clock from reaching zero. Edge
  # throttle first, then the global daily counter in DynamoDB.
  default_route_settings {
    throttling_burst_limit = 10
    throttling_rate_limit  = 5
  }
}

locals {
  # Everything is public by design: the Lambda only executes the fixed exhibit
  # statements (no user SQL anywhere), and the database role it uses can only
  # read the registry and write the rollback sandbox.
  routes = [
    "GET /api/status",
    "GET /api/exhibits",
    "POST /api/run/{id}",
  ]
}

resource "aws_apigatewayv2_integration" "query" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.query.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "all" {
  for_each  = toset(local.routes)
  api_id    = aws_apigatewayv2_api.http.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.query.id}"
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.query.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}
