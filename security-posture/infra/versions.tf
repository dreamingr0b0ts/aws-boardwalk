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
    key          = "security-posture.tfstate"
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
      env        = "security-posture"
      project    = "aws-boardwalk"
      managed_by = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  prefix     = "sec"
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region

  # Demo-stack discovery handshake: the demo root writes parameters under this
  # prefix while deployed and destroys them with the stack, so the always-on
  # API can answer 503 honestly between windows (plank 9/11 pattern).
  ssm_prefix = "/boardwalk/security-posture"
}
