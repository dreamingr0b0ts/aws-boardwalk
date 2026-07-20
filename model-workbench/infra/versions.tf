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
    key          = "model-workbench.tfstate"
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
      env        = "model-workbench"
      project    = "aws-boardwalk"
      managed_by = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  prefix     = "fmw"
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region

  # The whole roster in one place: it feeds the Lambdas (env var), the IAM
  # fence (exactly these profiles + their underlying foundation models), and
  # the cost math shown per response. Prices are published us-east-1
  # on-demand rates per 1M tokens, embedded for illustration.
  models = [
    {
      key     = "haiku"
      label   = "Claude Haiku 4.5"
      vendor  = "Anthropic"
      id      = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
      inPerM  = 1.00
      outPerM = 5.00
    },
    {
      key     = "nova-lite"
      label   = "Nova Lite"
      vendor  = "Amazon"
      id      = "us.amazon.nova-lite-v1:0"
      inPerM  = 0.06
      outPerM = 0.24
    },
    {
      key     = "llama"
      label   = "Llama 3.3 70B"
      vendor  = "Meta"
      id      = "us.meta.llama3-3-70b-instruct-v1:0"
      inPerM  = 0.72
      outPerM = 0.72
    },
    {
      key     = "pixtral"
      label   = "Pixtral Large"
      vendor  = "Mistral"
      id      = "us.mistral.pixtral-large-2502-v1:0"
      inPerM  = 2.00
      outPerM = 6.00
    },
  ]

  # Cross-region inference profiles need permission on the profile AND the
  # underlying foundation model in every region the profile can route to.
  model_invoke_arns = flatten([
    for m in local.models : [
      "arn:aws:bedrock:${local.region}:${local.account_id}:inference-profile/${m.id}",
      "arn:aws:bedrock:*::foundation-model/${replace(m.id, "us.", "")}",
    ]
  ])
}
