SHELL := /bin/bash
ACCOUNT := $(shell aws sts get-caller-identity --query Account --output text)
STATE_BUCKET := aws-boardwalk-tfstate-$(ACCOUNT)

.PHONY: bootstrap platform ns

## Create the Terraform state bucket (idempotent, once per account)
bootstrap:
	@aws s3api head-bucket --bucket "$(STATE_BUCKET)" 2>/dev/null || \
		aws s3api create-bucket --bucket "$(STATE_BUCKET)" --region us-east-1
	@aws s3api put-bucket-versioning --bucket "$(STATE_BUCKET)" --versioning-configuration Status=Enabled
	@aws s3api put-bucket-encryption --bucket "$(STATE_BUCKET)" \
		--server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
	@aws s3api put-public-access-block --bucket "$(STATE_BUCKET)" \
		--public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
	@echo "state bucket ready: $(STATE_BUCKET)"

## Apply shared DNS zone + wildcard cert
platform:
	terraform -chdir=platform init -backend-config="bucket=$(STATE_BUCKET)" -input=false
	terraform -chdir=platform apply -auto-approve -input=false

## Print the NS records to add at the registrar (GoDaddy: host "demos")
ns:
	@terraform -chdir=platform output name_servers
