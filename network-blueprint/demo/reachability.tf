# VPC Reachability Analyzer — AWS's own path analysis engine, $0.10 per run.
# Four paths, two designed to be reachable and two designed NOT to be: the
# segmentation claims on the site are proven by the analyzer's verdicts, not
# asserted. Analyses run during apply (wait_for_completion) and their results
# are read by the evidence Lambda.

locals {
  insights_paths = {
    igw-to-web-443 = {
      source      = aws_internet_gateway.igw.id
      destination = aws_instance.public_web.id
      port        = 443
      expect      = true
      label       = "internet (IGW) → web tier :443"
      because     = "public route table + web SG admit HTTPS"
    }
    igw-to-app-8080 = {
      source      = aws_internet_gateway.igw.id
      destination = aws_instance.private_app.id
      port        = 8080
      expect      = false
      label       = "internet (IGW) → app tier :8080"
      because     = "private subnets have no route to/from the IGW"
    }
    web-to-app-8080 = {
      source      = aws_instance.public_web.id
      destination = aws_instance.private_app.id
      port        = 8080
      expect      = true
      label       = "web tier → app tier :8080"
      because     = "app SG admits 8080 from the web SG"
    }
    web-to-app-5432 = {
      source      = aws_instance.public_web.id
      destination = aws_instance.private_app.id
      port        = 5432
      expect      = false
      label       = "web tier → app tier :5432"
      because     = "the data port is not open between these tiers"
    }
  }
}

resource "aws_ec2_network_insights_path" "path" {
  for_each = local.insights_paths

  source           = each.value.source
  destination      = each.value.destination
  protocol         = "tcp"
  destination_port = each.value.port

  tags = { Name = "${local.prefix}-${each.key}" }
}

resource "aws_ec2_network_insights_analysis" "analysis" {
  for_each = aws_ec2_network_insights_path.path

  network_insights_path_id = each.value.id
  wait_for_completion      = true

  # Analyses snapshot the configuration at run time — every rule they judge
  # must exist first, or the verdicts describe a half-built network.
  depends_on = [
    aws_vpc_security_group_ingress_rule.web_443_world,
    aws_vpc_security_group_ingress_rule.app_8080_from_web,
    aws_vpc_security_group_egress_rule.web_443_out,
    aws_vpc_security_group_egress_rule.web_to_app_8080,
    aws_vpc_security_group_egress_rule.web_5432_vpc,
    aws_network_acl_association.public,
    aws_network_acl_association.private,
    aws_route_table_association.public,
    aws_route_table_association.app,
  ]

  tags = { Name = "${local.prefix}-${each.key}" }
}
