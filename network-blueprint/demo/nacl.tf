# Custom NACLs — the stateless layer under the (stateful) security groups.
# Being stateless is what makes them look odd on first read: return traffic
# must be allowed explicitly, which is why both NACLs carry an ephemeral-port
# allow from 0.0.0.0/0 (that's responses coming back, not open ingress —
# unsolicited SYNs to those ports still die at the security groups).

resource "aws_network_acl" "public" {
  vpc_id = aws_vpc.lab.id

  # The explicit-deny exhibit: NACL rules evaluate in order, so RDP from the
  # internet is dead at rule 90 before the HTTPS allow at 100 is considered —
  # a guardrail security groups can't express (they have no deny).
  ingress {
    rule_no    = 90
    action     = "deny"
    protocol   = "tcp"
    from_port  = 3389
    to_port    = 3389
    cidr_block = "0.0.0.0/0"
  }

  ingress {
    rule_no    = 100
    action     = "allow"
    protocol   = "tcp"
    from_port  = 443
    to_port    = 443
    cidr_block = "0.0.0.0/0"
  }

  # return traffic for outbound connections (stateless — see header comment)
  ingress {
    rule_no    = 110
    action     = "allow"
    protocol   = "tcp"
    from_port  = 1024
    to_port    = 65535
    cidr_block = "0.0.0.0/0"
  }

  egress {
    rule_no    = 100
    action     = "allow"
    protocol   = "tcp"
    from_port  = 0
    to_port    = 65535
    cidr_block = "0.0.0.0/0"
  }

  tags = { Name = "${local.prefix}-public-nacl" }
}

resource "aws_network_acl" "private" {
  vpc_id = aws_vpc.lab.id

  # same explicit RDP deny as the public NACL — the ephemeral return-traffic
  # allow below would otherwise cover 3389 from anywhere
  ingress {
    rule_no    = 90
    action     = "deny"
    protocol   = "tcp"
    from_port  = 3389
    to_port    = 3389
    cidr_block = "0.0.0.0/0"
  }

  # intra-VPC traffic (web tier → app tier, endpoints, instance ↔ instance)
  ingress {
    rule_no    = 100
    action     = "allow"
    protocol   = "tcp"
    from_port  = 0
    to_port    = 65535
    cidr_block = local.vpc_cidr
  }

  # return traffic from S3/DynamoDB public IPs reached via gateway endpoints
  ingress {
    rule_no    = 110
    action     = "allow"
    protocol   = "tcp"
    from_port  = 1024
    to_port    = 65535
    cidr_block = "0.0.0.0/0"
  }

  egress {
    rule_no    = 100
    action     = "allow"
    protocol   = "tcp"
    from_port  = 0
    to_port    = 65535
    cidr_block = "0.0.0.0/0"
  }

  tags = { Name = "${local.prefix}-private-nacl" }
}

# Explicit association resources (rather than inline subnet_ids) so the
# NACL→subnet attachment is visible to graph-based policy checks.
resource "aws_network_acl_association" "public" {
  count          = 2
  network_acl_id = aws_network_acl.public.id
  subnet_id      = aws_subnet.public[count.index].id
}

resource "aws_network_acl_association" "private" {
  count          = 4
  network_acl_id = aws_network_acl.private.id
  subnet_id      = concat(aws_subnet.app[*].id, aws_subnet.data[*].id)[count.index]
}
