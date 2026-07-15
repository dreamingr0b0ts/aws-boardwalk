terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  backend "s3" {
    key          = "platform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
    # bucket is passed via -backend-config (account-specific); see root Makefile
  }
}

provider "aws" {
  region = "us-east-1"

  default_tags {
    tags = {
      env        = "platform"
      project    = "aws-boardwalk"
      managed_by = "terraform"
    }
  }
}
