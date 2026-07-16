SHELL := /bin/bash
ACCOUNT := $(shell aws sts get-caller-identity --query Account --output text)
STATE_BUCKET := aws-boardwalk-tfstate-$(ACCOUNT)
TF := terraform -chdir=infra

.PHONY: init build deploy publish ingest etl seed verify outputs destroy

init:
	$(TF) init -backend-config="bucket=$(STATE_BUCKET)" -input=false

build:
	cd backend && npm install --no-fund --no-audit && npm run build

## Full deployment: bundle code, apply infra, publish frontend.
## First deploy? Follow with `make seed` to fill the lake.
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

## Pull the full dataset from data.colorado.gov into the raw zone (~3.1M rows,
## a few minutes). Replaces the previous snapshot.
ingest:
	cd ingest && npm install --no-fund --no-audit
	LAKE_BUCKET=$$($(TF) output -raw lake_bucket) \
	RAW_PREFIX=$$($(TF) output -raw raw_prefix) \
		node ingest/fetch.mjs

## Rebuild the curated Parquet zone + dashboard aggregates from the raw zone.
## The Lambda can run up to 15 minutes; --cli-read-timeout 0 waits it out.
etl:
	@OUT=$$(mktemp); \
	aws lambda invoke --function-name "$$($(TF) output -raw etl_function)" \
		--cli-binary-format raw-in-base64-out --payload '{}' \
		--cli-read-timeout 0 --no-cli-pager "$$OUT" > /dev/null; \
	cat "$$OUT" | head -c 2000; echo; rm -f "$$OUT"

## Fill the lake end to end: source → raw → curated → analytics
seed: ingest etl

verify:
	./scripts/verify.sh

outputs:
	@$(TF) output

destroy:
	$(TF) destroy -auto-approve
