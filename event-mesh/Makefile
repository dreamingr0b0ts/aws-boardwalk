SHELL := /bin/bash
ACCOUNT := $(shell aws sts get-caller-identity --query Account --output text)
STATE_BUCKET := aws-boardwalk-tfstate-$(ACCOUNT)
TF := terraform -chdir=infra

.PHONY: init build deploy publish verify reset outputs destroy

init:
	$(TF) init -backend-config="bucket=$(STATE_BUCKET)" -input=false

build:
	cd backend && npm install --no-fund --no-audit && npm run build

## Full deployment: bundle code, apply infra, publish frontend
deploy: build init
	$(TF) apply -auto-approve -input=false
	$(MAKE) publish

## Upload frontend, then invalidate CloudFront (no runtime config needed —
## the API is same-origin behind /api/*)
publish:
	@BUCKET=$$($(TF) output -raw site_bucket); \
	DIST=$$($(TF) output -raw distribution_id); \
	aws s3 sync frontend "s3://$$BUCKET" --delete; \
	aws cloudfront create-invalidation --distribution-id "$$DIST" --paths "/*" --no-cli-pager --output text > /dev/null; \
	echo "published → $$($(TF) output -raw site_url)"

verify:
	./scripts/verify.sh

## Sweep traces and purge DLQs now (the same Lambda runs nightly at 09:00 UTC)
reset:
	@OUT=$$(mktemp); \
	aws lambda invoke --function-name "$$($(TF) output -raw reset_function)" \
		--cli-binary-format raw-in-base64-out --payload '{}' \
		--no-cli-pager "$$OUT" > /dev/null; \
	cat "$$OUT"; echo; rm -f "$$OUT"

outputs:
	@$(TF) output

destroy:
	$(TF) destroy -auto-approve
