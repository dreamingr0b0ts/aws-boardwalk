# Discovery parameters for the always-on inspection API (../infra). The API
# and its runner Lambda live outside this root so visitors can trigger live
# probe rounds, but everything they need to reach only exists during demo
# windows. These parameters ARE the handshake: present while the stack is
# deployed, destroyed with it, so the API can answer 503 honestly between
# windows (same pattern as plank 11's cluster discovery).

locals {
  ssm_prefix = "/boardwalk/network-blueprint"
}

resource "aws_ssm_parameter" "public_instance_id" {
  name  = "${local.ssm_prefix}/public-instance-id"
  type  = "SecureString"
  value = aws_instance.public_web.id
}

resource "aws_ssm_parameter" "private_instance_id" {
  name  = "${local.ssm_prefix}/private-instance-id"
  type  = "SecureString"
  value = aws_instance.private_app.id
}

resource "aws_ssm_parameter" "private_app_ip" {
  name  = "${local.ssm_prefix}/private-app-ip"
  type  = "SecureString"
  value = aws_instance.private_app.private_ip
}

# The four Reachability Analyzer verdicts from this window's deploy; the
# runner's plan-check stage re-reads them live and compares them against the
# field results.
resource "aws_ssm_parameter" "analyses" {
  name = "${local.ssm_prefix}/analyses"
  type = "SecureString"
  value = jsonencode([
    for key, path in local.insights_paths : {
      key    = key
      id     = aws_ec2_network_insights_analysis.analysis[key].id
      expect = path.expect
      label  = path.label
    }
  ])
}
