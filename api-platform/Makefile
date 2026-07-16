SHELL := /bin/bash
ACCOUNT := $(shell aws sts get-caller-identity --query Account --output text)
STATE_BUCKET := aws-boardwalk-tfstate-$(ACCOUNT)
TF := terraform -chdir=infra

.PHONY: init build deploy publish seed verify outputs destroy

init:
	$(TF) init -backend-config="bucket=$(STATE_BUCKET)" -input=false

build:
	cd backend && npm install --no-fund --no-audit && npm run build

## Full deployment: bundle code, apply infra, publish docs site, seed catalogs
deploy: build init
	$(TF) apply -auto-approve -input=false
	$(MAKE) publish
	$(MAKE) seed

## Upload docs site + publish-time artifacts: the rendered OpenAPI contract
## (x-amazon-* wiring stripped) and config.json carrying the demo key — the
## key is public by design but lives in state, never in the repo.
publish:
	@BUCKET=$$($(TF) output -raw site_bucket); \
	DIST=$$($(TF) output -raw distribution_id); \
	SITE=$$($(TF) output -raw site_url); \
	node backend/spec-to-json.mjs infra/openapi.yaml frontend/openapi.json "$$SITE"; \
	jq -n --arg key "$$($(TF) output -raw demo_api_key)" '{demoKey: $$key}' > frontend/config.json; \
	aws s3 sync frontend "s3://$$BUCKET" --delete; \
	aws cloudfront create-invalidation --distribution-id "$$DIST" --paths "/*" --no-cli-pager --output text > /dev/null; \
	echo "published → $$SITE"

## Idempotent deterministic seed of the three service catalogs (240 permits,
## 160 licenses, 24 facilities) — same ids every run, PutItem overwrites.
seed:
	@cd backend && \
	PERMITS_TABLE=$$(terraform -chdir=../infra output -raw permits_table) \
	LICENSES_TABLE=$$(terraform -chdir=../infra output -raw licenses_table) \
	FACILITIES_TABLE=$$(terraform -chdir=../infra output -raw facilities_table) \
	node seed.mjs

verify:
	./scripts/verify.sh

outputs:
	@$(TF) output

destroy:
	$(TF) destroy -auto-approve
