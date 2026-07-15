SHELL := /bin/bash
ACCOUNT := $(shell aws sts get-caller-identity --query Account --output text)
STATE_BUCKET := aws-boardwalk-tfstate-$(ACCOUNT)
TF := terraform -chdir=infra

.PHONY: init build deploy publish seed verify outputs enable-domain destroy

init:
	$(TF) init -backend-config="bucket=$(STATE_BUCKET)" -input=false

build:
	cd backend && npm install --no-fund --no-audit && npm run build
	cd frontend && npm install --no-fund --no-audit && npm run build

## Full deployment: bundle code, apply infra, publish frontend, seed data
deploy: build init
	$(TF) apply -auto-approve -input=false
	$(MAKE) publish
	$(MAKE) seed

## Upload frontend build + runtime config, then invalidate CloudFront
publish:
	@BUCKET=$$($(TF) output -raw site_bucket); \
	DIST=$$($(TF) output -raw distribution_id); \
	$(TF) output -json | jq '{region: "us-east-1", userPoolId: .user_pool_id.value, userPoolClientId: .user_pool_client_id.value}' \
		> frontend/dist/config.json; \
	aws s3 sync frontend/dist "s3://$$BUCKET" --delete; \
	aws cloudfront create-invalidation --distribution-id "$$DIST" --paths "/*" --no-cli-pager --output text > /dev/null; \
	echo "published → https://$$($(TF) output -raw cloudfront_domain)"

## Reset + reseed demo data and demo accounts (same code the nightly run uses)
seed:
	@OUT=$$(mktemp); \
	aws lambda invoke --function-name "$$($(TF) output -raw demo_reset_function)" \
		--cli-binary-format raw-in-base64-out --payload '{"mode":"reset"}' \
		--no-cli-pager "$$OUT" > /dev/null; \
	cat "$$OUT"; echo; rm -f "$$OUT"

verify:
	./scripts/verify.sh

outputs:
	@$(TF) output

## Attach permits.demos.planetek.org — only after the ACM cert shows ISSUED
enable-domain: init
	$(TF) apply -auto-approve -input=false -var custom_domain_enabled=true

destroy:
	$(TF) destroy -auto-approve
