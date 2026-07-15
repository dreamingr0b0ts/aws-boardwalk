# One pane of glass for the whole boardwalk. First 3 dashboards are free.

locals {
  cf_region = "us-east-1" # CloudFront metrics only exist here, dimension Region=Global

  dashboard_body = jsonencode({
    widgets = [
      {
        type = "text", x = 0, y = 0, width = 24, height = 2
        properties = {
          markdown = "# aws-boardwalk — operations\nLive planks: [hub](https://demos.planetek.org) · [permits](https://permits.demos.planetek.org) · [assistant](https://assistant.demos.planetek.org) · pipeline: [GitHub Actions](https://github.com/${var.github_repo}/actions)"
        }
      },
      {
        type = "metric", x = 0, y = 2, width = 12, height = 6
        properties = {
          title  = "CloudFront requests (all planks)"
          region = local.cf_region
          stat   = "Sum"
          period = 300
          metrics = [
            ["AWS/CloudFront", "Requests", "DistributionId", local.hub_dist_id, "Region", "Global", { label = "hub" }],
            ["...", local.mwa_dist_id, ".", ".", { label = "permits" }],
            ["...", local.gai_dist_id, ".", ".", { label = "assistant" }],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 2, width = 12, height = 6
        properties = {
          title  = "CloudFront 5xx error rate (%)"
          region = local.cf_region
          stat   = "Average"
          period = 300
          yAxis  = { left = { min = 0, max = 100 } }
          metrics = [
            ["AWS/CloudFront", "5xxErrorRate", "DistributionId", local.hub_dist_id, "Region", "Global", { label = "hub" }],
            ["...", local.mwa_dist_id, ".", ".", { label = "permits" }],
            ["...", local.gai_dist_id, ".", ".", { label = "assistant" }],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 8, width = 8, height = 6
        properties = {
          title  = "HTTP API traffic"
          region = local.region
          stat   = "Sum"
          period = 300
          metrics = [
            ["AWS/ApiGateway", "Count", "ApiId", local.mwa_api_id, { label = "permits requests" }],
            ["AWS/ApiGateway", "5xx", "ApiId", local.mwa_api_id, { label = "permits 5xx", color = "#d62728" }],
            ["AWS/ApiGateway", "Count", "ApiId", local.gai_api_id, { label = "assistant requests" }],
            ["AWS/ApiGateway", "5xx", "ApiId", local.gai_api_id, { label = "assistant 5xx", color = "#9467bd" }],
          ]
        }
      },
      {
        type = "metric", x = 8, y = 8, width = 8, height = 6
        properties = {
          title  = "API latency p95 (ms)"
          region = local.region
          stat   = "p95"
          period = 300
          metrics = [
            ["AWS/ApiGateway", "Latency", "ApiId", local.mwa_api_id, { label = "permits" }],
            ["AWS/ApiGateway", "Latency", "ApiId", local.gai_api_id, { label = "assistant" }],
          ]
        }
      },
      {
        type = "metric", x = 16, y = 8, width = 8, height = 6
        properties = {
          title  = "Lambda errors"
          region = local.region
          stat   = "Sum"
          period = 300
          metrics = [
            ["AWS/Lambda", "Errors", "FunctionName", "mwa-public", { label = "mwa-public" }],
            ["...", "mwa-me", { label = "mwa-me" }],
            ["...", "mwa-admin", { label = "mwa-admin" }],
            ["...", "gai-public", { label = "gai-public" }],
            ["...", "gai-chat", { label = "gai-chat" }],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 14, width = 8, height = 6
        properties = {
          title  = "DynamoDB consumed capacity"
          region = local.region
          stat   = "Sum"
          period = 300
          metrics = [
            ["AWS/DynamoDB", "ConsumedReadCapacityUnits", "TableName", local.mwa_table, { label = "permits RCU" }],
            ["AWS/DynamoDB", "ConsumedWriteCapacityUnits", "TableName", local.mwa_table, { label = "permits WCU" }],
            ["AWS/DynamoDB", "ConsumedReadCapacityUnits", "TableName", local.gai_table, { label = "assistant RCU" }],
            ["AWS/DynamoDB", "ConsumedWriteCapacityUnits", "TableName", local.gai_table, { label = "assistant WCU" }],
          ]
        }
      },
      {
        type = "metric", x = 8, y = 14, width = 8, height = 6
        properties = {
          title  = "Canary availability (%) — runs only during demo windows"
          region = local.region
          stat   = "Average"
          period = 300
          yAxis  = { left = { min = 0, max = 100 } }
          metrics = [
            ["CloudWatchSynthetics", "SuccessPercent", "CanaryName", aws_synthetics_canary.heartbeat.name, { label = "heartbeat" }],
          ]
        }
      },
      {
        type = "metric", x = 16, y = 14, width = 8, height = 6
        properties = {
          title  = "Bedrock invocations (assistant)"
          region = local.region
          stat   = "Sum"
          period = 3600
          metrics = [
            ["AWS/Bedrock", "Invocations", { label = "invocations" }],
            ["AWS/Bedrock", "InvocationClientErrors", { label = "client errors" }],
          ]
        }
      },
    ]
  })
}

resource "aws_cloudwatch_dashboard" "boardwalk" {
  dashboard_name = "${local.prefix}-boardwalk"
  dashboard_body = local.dashboard_body
}
