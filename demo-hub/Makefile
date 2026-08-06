SHELL := /bin/bash
ACCOUNT := $(shell aws sts get-caller-identity --query Account --output text)
STATE_BUCKET := aws-boardwalk-tfstate-$(ACCOUNT)
TF := terraform -chdir=infra

.PHONY: init deploy publish outputs destroy

init:
	$(TF) init -backend-config="bucket=$(STATE_BUCKET)" -input=false

deploy: init
	$(TF) apply -auto-approve -input=false
	$(MAKE) publish

# Same three cache tiers as company-site (see that Makefile's note): fonts a
# year, images a day, HTML and friends revalidate in five minutes.
publish:
	@BUCKET=$$($(TF) output -raw site_bucket); \
	DIST=$$($(TF) output -raw distribution_id); \
	aws s3 sync site "s3://$$BUCKET" --exclude "*" --include "fonts/*" \
	  --cache-control "public, max-age=31536000, immutable"; \
	aws s3 sync site "s3://$$BUCKET" --exclude "*" \
	  --include "*.webp" --include "*.jpg" --include "*.png" --include "*.svg" --include "*.ico" \
	  --exclude "fonts/*" --cache-control "public, max-age=86400"; \
	aws s3 sync site "s3://$$BUCKET" --delete \
	  --cache-control "public, max-age=300, must-revalidate"; \
	aws cloudfront create-invalidation --distribution-id "$$DIST" --paths "/*" --no-cli-pager --output text > /dev/null; \
	echo "published → $$($(TF) output -raw hub_url)"

outputs:
	@$(TF) output

destroy:
	$(TF) destroy -auto-approve
