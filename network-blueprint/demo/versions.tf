# ── THE TEARDOWN ROOT ─────────────────────────────────────────────────────────
# EC2 instances, interface endpoints, and flow logs all bill by the hour, so
# this root exists only during demo windows: `make demo` up, `make teardown`
# down. It is DELIBERATELY absent from .github/workflows/terraform.yml — CI
# applies every always-on root on each push to main, and applying this one
# would silently re-start ~$0.04/hr of network lab on every push. Keep it local.
# The always-on half of the plank (site + persisted evidence) lives in ../infra.

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }

  backend "s3" {
    key          = "network-blueprint-demo.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
    # bucket is passed via -backend-config (account-specific); see Makefile
  }
}

provider "aws" {
  region = "us-east-1"

  default_tags {
    tags = {
      env        = "network-blueprint"
      project    = "aws-boardwalk"
      managed_by = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  prefix     = "net"
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region
}

# The always-on root owns the site bucket the evidence report is written to.
data "terraform_remote_state" "infra" {
  backend = "s3"

  config = {
    bucket = var.state_bucket
    key    = "network-blueprint.tfstate"
    region = "us-east-1"
  }
}

variable "state_bucket" {
  description = "Terraform state bucket (account-specific, passed by the Makefile)"
  type        = string
}
