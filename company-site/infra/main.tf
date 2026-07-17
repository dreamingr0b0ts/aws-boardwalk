terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  backend "s3" {
    key          = "company-site.tfstate"
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
      env        = "company-site"
      project    = "aws-boardwalk"
      managed_by = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}

variable "domain" {
  description = "The company apex domain"
  type        = string
  default     = "planetek.org"
}

variable "contact_email" {
  description = "Where contact-form submissions are delivered (iCloud-hosted mailbox)"
  type        = string
  default     = "info@planetek.org"
}

variable "custom_domain_enabled" {
  description = "Attach planetek.org + www to CloudFront. Requires the ACM cert to be ISSUED first (validation CNAME added at GoDaddy pre-cutover). Default MUST match live state — CI applies defaults."
  type        = bool
  default     = false
}

locals {
  prefix     = "www"
  account_id = data.aws_caller_identity.current.account_id
  www_domain = "www.${var.domain}"
}
