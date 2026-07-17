# Security-group tiering: each tier admits exactly one port from exactly one
# upstream tier — 443 (world) → web → 8080 → app → 5432 → data. Rules
# reference security groups, not CIDRs, so membership IS the policy: a new
# app instance is reachable from the web tier the moment it joins net-app-sg.
#
# Rules live in standalone resources (not inline) because web ⇄ app reference
# each other — inline rules would make the two groups a dependency cycle.

resource "aws_security_group" "web" {
  name        = "${local.prefix}-web-sg"
  description = "Web tier: HTTPS from the internet, egress fenced to AWS APIs and the app tier"
  vpc_id      = aws_vpc.lab.id

  tags = { Name = "${local.prefix}-web-sg", tier = "web" }
}

resource "aws_security_group" "app" {
  name        = "${local.prefix}-app-sg"
  description = "App tier: reachable ONLY from the web tier on 8080"
  vpc_id      = aws_vpc.lab.id

  tags = { Name = "${local.prefix}-app-sg", tier = "app" }
}

# The data tier is defined but deliberately vacant — a third instance would
# add cost without adding proof. The 5432 chain is still exercised: the
# web→5432 probe and the Reachability Analyzer path both die at
# net-app-sg's ingress, exactly where the tiering says they must.
resource "aws_security_group" "data" {
  name        = "${local.prefix}-data-sg"
  description = "Data tier: reachable ONLY from the app tier on 5432; no egress at all"
  vpc_id      = aws_vpc.lab.id

  tags = { Name = "${local.prefix}-data-sg", tier = "data" }
}

resource "aws_security_group" "vpce" {
  name        = "${local.prefix}-vpce-sg"
  description = "SSM interface endpoints: HTTPS from inside the VPC only"
  vpc_id      = aws_vpc.lab.id

  tags = { Name = "${local.prefix}-vpce-sg" }
}

# ── web tier rules ────────────────────────────────────────────────────────────

resource "aws_vpc_security_group_ingress_rule" "web_443_world" {
  security_group_id = aws_security_group.web.id
  description       = "HTTPS from anywhere (public tier by design; Reachability Analyzer proves it)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "web_443_out" {
  security_group_id = aws_security_group.web.id
  description       = "HTTPS out: SSM registration, AWS APIs, the internet-egress probe"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "web_to_app_8080" {
  security_group_id            = aws_security_group.web.id
  description                  = "app tier service port"
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
  referenced_security_group_id = aws_security_group.app.id
}

resource "aws_vpc_security_group_egress_rule" "web_5432_vpc" {
  security_group_id = aws_security_group.web.id
  description       = "deliberately allowed toward the data port so the 5432 probe dies at the app tier ingress, not here"
  ip_protocol       = "tcp"
  from_port         = 5432
  to_port           = 5432
  cidr_ipv4         = local.vpc_cidr
}

# ── app tier rules ────────────────────────────────────────────────────────────

resource "aws_vpc_security_group_ingress_rule" "app_8080_from_web" {
  security_group_id            = aws_security_group.app.id
  description                  = "service port, web tier only (SG reference, not CIDR)"
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
  referenced_security_group_id = aws_security_group.web.id
}

resource "aws_vpc_security_group_egress_rule" "app_443_out" {
  security_group_id = aws_security_group.app.id
  description       = "HTTPS out: SSM interface endpoints + S3/DynamoDB gateway endpoints (no internet path exists to use)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

# ── data tier rules ───────────────────────────────────────────────────────────

resource "aws_vpc_security_group_ingress_rule" "data_5432_from_app" {
  security_group_id            = aws_security_group.data.id
  description                  = "PostgreSQL, app tier only"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.app.id
}

# ── endpoint rules ────────────────────────────────────────────────────────────

resource "aws_vpc_security_group_ingress_rule" "vpce_443_vpc" {
  security_group_id = aws_security_group.vpce.id
  description       = "HTTPS from the VPC (SSM agent traffic)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = local.vpc_cidr
}
