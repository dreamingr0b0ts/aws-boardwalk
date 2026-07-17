SHELL := /bin/bash
ACCOUNT := $(shell aws sts get-caller-identity --query Account --output text)
STATE_BUCKET := aws-boardwalk-tfstate-$(ACCOUNT)
TF := terraform -chdir=infra

.PHONY: init deploy publish verify outputs cert-status destroy

init:
	$(TF) init -backend-config="bucket=$(STATE_BUCKET)" -input=false

deploy: init
	$(TF) apply -auto-approve -input=false
	$(MAKE) publish

publish:
	@BUCKET=$$($(TF) output -raw site_bucket); \
	DIST=$$($(TF) output -raw distribution_id); \
	aws s3 sync site "s3://$$BUCKET" --delete; \
	aws cloudfront create-invalidation --distribution-id "$$DIST" --paths "/*" --no-cli-pager --output text > /dev/null; \
	echo "published → $$($(TF) output -raw site_url)"

verify:
	./scripts/verify.sh

outputs:
	@$(TF) output

cert-status:
	@aws acm describe-certificate --certificate-arn "$$($(TF) output -raw cert_arn)" \
		--query 'Certificate.{Status:Status,Validation:DomainValidationOptions[].{Domain:DomainName,Status:ValidationStatus}}' --output table

# The zone carries live mail records and is prevent_destroy — `destroy` is
# expected to stop there. Remove the guard consciously if the domain ever leaves.
destroy:
	$(TF) destroy -auto-approve
