# Fargate tasks launch into the account's default VPC on public subnets with
# a public IP — that's how they reach ECR/S3/CloudWatch without a NAT gateway
# (banned always-on cost) or VPC endpoints (~$22/mo for the interface set).
# The trade-off is deliberate and documented on the site: the task's security
# group has NO ingress at all, so "public" means outbound-only.

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default_public" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

resource "aws_security_group" "task" {
  name        = "${local.prefix}-task"
  description = "ctr Fargate tasks: no ingress; egress 443 only (ECR pull, S3 artifact upload, CloudWatch Logs)"
  vpc_id      = data.aws_vpc.default.id

  egress {
    description = "HTTPS to AWS APIs (ECR, S3, CloudWatch Logs)"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
