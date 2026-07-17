# VPC endpoints — the reason the private tiers need no NAT.
#
# Gateway endpoints (S3, DynamoDB): FREE. They inject AWS prefix-list routes
# into the private route tables, so private instances reach both services
# without any internet path existing at all.
#
# Interface endpoints (SSM trio): $0.01/hr each — the plank's main running
# cost and the reason it's deploy-demo-teardown. They're PrivateLink ENIs
# inside the app subnet, letting Session Manager/Run Command manage the
# private instance that has no other way to be reached (no NAT, no bastion,
# no SSH port anywhere).

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.lab.id
  service_name      = "com.amazonaws.${local.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.app.id, aws_route_table.data.id]

  tags = { Name = "${local.prefix}-s3-gw" }
}

resource "aws_vpc_endpoint" "dynamodb" {
  vpc_id            = aws_vpc.lab.id
  service_name      = "com.amazonaws.${local.region}.dynamodb"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.app.id, aws_route_table.data.id]

  tags = { Name = "${local.prefix}-ddb-gw" }
}

# One subnet (one AZ) per endpoint, not two: halves the hourly cost, and AZ
# resilience for a demo-window management path isn't worth paying for.
resource "aws_vpc_endpoint" "ssm" {
  for_each = toset(["ssm", "ssmmessages", "ec2messages"])

  vpc_id              = aws_vpc.lab.id
  service_name        = "com.amazonaws.${local.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.app[0].id]
  security_group_ids  = [aws_security_group.vpce.id]
  private_dns_enabled = true

  tags = { Name = "${local.prefix}-${each.key}-vpce" }
}
