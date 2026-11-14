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
    key          = "relational-registry.tfstate"
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

  # Written by the demo root when the Aurora stack is up, deleted at teardown.
  # The always-on query Lambda discovers the cluster through these at runtime,
  # so this root never has to know whether the database currently exists.
  ssm_prefix = "/boardwalk/relational-registry"

  # Ceiling every role in this root carries. CI can only create or edit roles
  # that have it: see the fence in devops-sre/infra/github-oidc.tf.
  role_boundary_arn = "arn:aws:iam::${local.account_id}:policy/boardwalk-role-boundary"
}
