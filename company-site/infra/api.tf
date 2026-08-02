resource "aws_apigatewayv2_api" "http" {
  name          = "${local.prefix}-api"
  protocol_type = "HTTP"
  description   = "Planetek contact form — served same-origin behind CloudFront /api/*"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  # A contact form needs single-digit rps at most; anything more is abuse.
  default_route_settings {
    throttling_burst_limit = 10
    throttling_rate_limit  = 5
  }
}

resource "aws_apigatewayv2_integration" "contact" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.contact.invoke_arn
  payload_format_version = "2.0"
}

# Public by design (CKV_AWS_309 globally accepted): abuse is handled by the
# stage throttle, honeypot, and daily DynamoDB caps.
resource "aws_apigatewayv2_route" "contact" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "POST /api/contact"
  target    = "integrations/${aws_apigatewayv2_integration.contact.id}"
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.contact.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

# ---- the booking desk rides the same HTTP API ------------------------------

resource "aws_apigatewayv2_integration" "schedule" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.schedule.invoke_arn
  payload_format_version = "2.0"
}

# Public by design, same abuse posture as the contact route: stage throttle,
# honeypot, and daily DynamoDB caps (3/IP, 10 global).
resource "aws_apigatewayv2_route" "schedule_slots" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "GET /api/schedule/slots"
  target    = "integrations/${aws_apigatewayv2_integration.schedule.id}"
}

resource "aws_apigatewayv2_route" "schedule_book" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "POST /api/schedule/book"
  target    = "integrations/${aws_apigatewayv2_integration.schedule.id}"
}

resource "aws_lambda_permission" "apigw_schedule" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.schedule.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}
