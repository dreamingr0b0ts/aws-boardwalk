# VPC flow logs → CloudWatch Logs, 60s aggregation so records land fast
# enough to appear in the evidence report generated minutes after deploy.
# The public instance's ENI collects genuine internet background noise
# (scanners probing a fresh public IP) — the REJECT records in the evidence
# are real strangers being turned away by the security group.

resource "aws_cloudwatch_log_group" "flow" {
  name              = "/aws/vpc/${local.prefix}-flow-logs"
  retention_in_days = 14
}

resource "aws_iam_role" "flow" {
  name = "${local.prefix}-flow-logs-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "flow" {
  name = "deliver-flow-logs"
  role = aws_iam_role.flow.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
      Resource = "${aws_cloudwatch_log_group.flow.arn}:*"
    }]
  })
}

resource "aws_flow_log" "vpc" {
  vpc_id                   = aws_vpc.lab.id
  traffic_type             = "ALL"
  log_destination_type     = "cloud-watch-logs"
  log_destination          = aws_cloudwatch_log_group.flow.arn
  iam_role_arn             = aws_iam_role.flow.arn
  max_aggregation_interval = 60

  tags = { Name = "${local.prefix}-vpc-flow" }
}
