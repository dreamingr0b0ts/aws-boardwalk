# REST API Gateway (not HTTP API) on purpose: API keys, usage plans with
# quotas, and model-based request validation only exist on the REST flavor —
# they ARE this plank's exhibit. The whole API is imported from openapi.yaml;
# no aws_api_gateway_resource/method resources exist to drift from the spec.

locals {
  lambda_uris = {
    permits_uri    = aws_lambda_function.permits.invoke_arn
    licenses_uri   = aws_lambda_function.licenses.invoke_arn
    facilities_uri = aws_lambda_function.facilities.invoke_arn
    status_uri     = aws_lambda_function.status.invoke_arn
  }

  # yamldecode → jsonencode so API Gateway always receives canonical JSON,
  # and a YAML typo fails at plan time instead of at PUT time.
  openapi_body = jsonencode(yamldecode(templatefile("${path.module}/openapi.yaml", local.lambda_uris)))
}

resource "aws_api_gateway_rest_api" "api" {
  name              = "${local.prefix}-api"
  description       = "City of Alpenglow Developer API — served same-origin behind CloudFront /v1/* and /v2/*"
  body              = local.openapi_body
  put_rest_api_mode = "overwrite" # the spec is the whole truth; no out-of-band edits survive

  endpoint_configuration {
    types = ["REGIONAL"] # CloudFront in front; edge-optimized would double-hop
  }

  lifecycle {
    create_before_destroy = true # REST API names aren't unique, so this is safe
  }
}

resource "aws_api_gateway_deployment" "live" {
  rest_api_id = aws_api_gateway_rest_api.api.id

  triggers = {
    redeployment = sha1(local.openapi_body)
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_api_gateway_stage" "live" {
  rest_api_id          = aws_api_gateway_rest_api.api.id
  deployment_id        = aws_api_gateway_deployment.live.id
  stage_name           = "live"
  xray_tracing_enabled = true
}

# Stage-wide ceiling. This bounds the two keyless routes (/v2/status, /v1/ping)
# and is the outer wall behind the per-key usage plans.
resource "aws_api_gateway_method_settings" "all" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  stage_name  = aws_api_gateway_stage.live.stage_name
  method_path = "*/*"

  settings {
    throttling_rate_limit  = 25
    throttling_burst_limit = 50
    metrics_enabled        = true
  }
}

# --- usage plans: the governance exhibit -------------------------------------
# demo    — shared key printed on the docs page; tight throttle + daily quota
#           so one visitor can't spoil the demo for the next.
# partner — what a real integrator would get; the key exists but is never
#           distributed (verify reads it from state to prove the tier works).

resource "aws_api_gateway_usage_plan" "demo" {
  name        = "${local.prefix}-demo"
  description = "Shared docs-page key: try-it consoles, curl quickstarts"

  api_stages {
    api_id = aws_api_gateway_rest_api.api.id
    stage  = aws_api_gateway_stage.live.stage_name
  }

  quota_settings {
    limit  = var.demo_quota_per_day
    period = "DAY"
  }

  throttle_settings {
    rate_limit  = var.demo_rate_limit
    burst_limit = var.demo_burst_limit
  }
}

resource "aws_api_gateway_usage_plan" "partner" {
  name        = "${local.prefix}-partner"
  description = "Per-integrator tier: issued individually, never published"

  api_stages {
    api_id = aws_api_gateway_rest_api.api.id
    stage  = aws_api_gateway_stage.live.stage_name
  }

  quota_settings {
    limit  = 50000
    period = "DAY"
  }

  throttle_settings {
    rate_limit  = 25
    burst_limit = 50
  }
}

resource "aws_api_gateway_api_key" "demo" {
  name        = "${local.prefix}-demo-key"
  description = "Public by design — printed on the docs page (nothing behind it costs real money; the usage plan bounds nuisance)"
}

resource "aws_api_gateway_api_key" "partner" {
  name        = "${local.prefix}-partner-key"
  description = "Demonstration partner-tier key; never printed or committed"
}

resource "aws_api_gateway_usage_plan_key" "demo" {
  key_id        = aws_api_gateway_api_key.demo.id
  key_type      = "API_KEY"
  usage_plan_id = aws_api_gateway_usage_plan.demo.id
}

resource "aws_api_gateway_usage_plan_key" "partner" {
  key_id        = aws_api_gateway_api_key.partner.id
  key_type      = "API_KEY"
  usage_plan_id = aws_api_gateway_usage_plan.partner.id
}

# --- lambda invoke permissions ------------------------------------------------

resource "aws_lambda_permission" "apigw" {
  for_each = {
    permits    = aws_lambda_function.permits.function_name
    licenses   = aws_lambda_function.licenses.function_name
    facilities = aws_lambda_function.facilities.function_name
    status     = aws_lambda_function.status.function_name
  }

  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = each.value
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*"
}
