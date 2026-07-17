# Two t4g.nano instances (~$0.004/hr each) — the smallest possible probes
# that make the paths real. Both are SSM-managed (no SSH anywhere): the
# public one registers over the internet, the private one over the interface
# endpoints — which is itself one of the exhibits.

data "aws_ssm_parameter" "al2023_arm64" {
  # standard (not minimal) AL2023: the minimal AMI ships without the SSM agent
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

resource "aws_iam_role" "instance" {
  for_each = toset(["web", "app"])

  name = "${local.prefix}-${each.key}-instance-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "instance_ssm" {
  for_each = aws_iam_role.instance

  role       = each.value.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "instance" {
  for_each = aws_iam_role.instance

  name = "${local.prefix}-${each.key}-instance-profile"
  role = each.value.name
}

locals {
  instance_common = {
    instance_type = "t4g.nano"
    ami           = nonsensitive(data.aws_ssm_parameter.al2023_arm64.value)
  }
}

resource "aws_instance" "public_web" {
  ami                         = local.instance_common.ami
  instance_type               = local.instance_common.instance_type
  subnet_id                   = aws_subnet.public[0].id
  vpc_security_group_ids      = [aws_security_group.web.id]
  iam_instance_profile        = aws_iam_instance_profile.instance["web"].name
  associate_public_ip_address = true # the public-path exhibit (per-instance, never a subnet default)
  ebs_optimized               = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required" # IMDSv2 only — proven live by the probe suite
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 8
    encrypted   = true
  }

  tags = { Name = "${local.prefix}-public-web", tier = "web" }
}

resource "aws_instance" "private_app" {
  ami                    = local.instance_common.ami
  instance_type          = local.instance_common.instance_type
  subnet_id              = aws_subnet.app[0].id
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.instance["app"].name
  ebs_optimized          = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 8
    encrypted   = true
  }

  # a real listener on the app port so the web→app:8080 path carries actual
  # HTTP, not just a Reachability Analyzer verdict
  user_data = <<-EOT
    #!/bin/bash
    cat >/etc/systemd/system/demo-app.service <<'UNIT'
    [Unit]
    Description=app-tier demo listener
    [Service]
    ExecStart=/usr/bin/python3 -m http.server 8080
    Restart=always
    [Install]
    WantedBy=multi-user.target
    UNIT
    systemctl daemon-reload
    systemctl enable --now demo-app
  EOT

  tags = { Name = "${local.prefix}-private-app", tier = "app" }
}
