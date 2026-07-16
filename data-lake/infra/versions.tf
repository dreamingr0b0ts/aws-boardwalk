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
    key          = "data-lake.tfstate"
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
      env        = "data-lake"
      project    = "aws-boardwalk"
      managed_by = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  prefix     = "dla"
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region

  # One bucket, three zones — prefixes are the boundary, IAM enforces it.
  raw_prefix       = "raw/business_entities"
  curated_prefix   = "curated/business_entities"
  analytics_prefix = "analytics"
  results_prefix   = "athena-results"

  glue_db       = "dla_lake"
  raw_table     = "business_entities_raw"
  curated_table = "business_entities"
}
