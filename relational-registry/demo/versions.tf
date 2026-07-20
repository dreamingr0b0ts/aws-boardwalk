# ── THE TEARDOWN ROOT ─────────────────────────────────────────────────────────
# RDS is on the boardwalk's banned-always-on list, so the Aurora cluster lives
# here and exists only during demo windows: `make demo` up, `make teardown`
# down. It is DELIBERATELY absent from .github/workflows/terraform.yml — CI
# applies every always-on root on each push to main, and applying this one
# would silently re-create a database. Keep it local.
#
# Even while deployed the cluster is Serverless v2 with min_capacity = 0:
# after 5 idle minutes it auto-pauses and compute billing stops entirely —
# a deployed-but-idle window costs storage pennies. The always-on half of the
# plank (site + query API + persisted evidence) lives in ../infra.

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
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  backend "s3" {
    key          = "relational-registry-demo.tfstate"
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
      env        = "relational-registry"
      project    = "aws-boardwalk"
      managed_by = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  prefix     = "rdb"
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region
  ssm_prefix = "/boardwalk/relational-registry"
}

# The always-on root owns the site bucket the evidence report is written to.
data "terraform_remote_state" "infra" {
  backend = "s3"

  config = {
    bucket = var.state_bucket
    key    = "relational-registry.tfstate"
    region = "us-east-1"
  }
}

variable "state_bucket" {
  description = "Terraform state bucket (account-specific, passed by the Makefile)"
  type        = string
}
