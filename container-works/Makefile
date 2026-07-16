SHELL := /bin/bash
ACCOUNT := $(shell aws sts get-caller-identity --query Account --output text)
STATE_BUCKET := aws-boardwalk-tfstate-$(ACCOUNT)
TF := terraform -chdir=infra

.PHONY: init build deploy publish image verify outputs destroy

init:
	$(TF) init -backend-config="bucket=$(STATE_BUCKET)" -input=false

build:
	cd backend && npm install --no-fund --no-audit && npm run build

## Full deployment: bundle code, apply infra, publish frontend.
## First-ever deploy also needs `make image` (the ECR repo starts empty).
deploy: build init
	$(TF) apply -auto-approve -input=false
	$(MAKE) publish

## Upload frontend, then invalidate CloudFront. artifacts/ belongs to the
## containers — never let a site sync delete their reports.
publish:
	@BUCKET=$$($(TF) output -raw site_bucket); \
	DIST=$$($(TF) output -raw distribution_id); \
	aws s3 sync frontend "s3://$$BUCKET" --delete --exclude "artifacts/*"; \
	aws cloudfront create-invalidation --distribution-id "$$DIST" --paths "/*" --no-cli-pager --output text > /dev/null; \
	echo "published → $$($(TF) output -raw site_url)"

## The image pipeline: zip app/ → S3 → CodeBuild (docker build+push) → ECR
## scan-on-push. No Docker needed on this machine — that's the point.
image:
	@set -e; \
	SRC_BUCKET=$$($(TF) output -raw build_src_bucket); \
	PROJECT=$$($(TF) output -raw build_project); \
	REPO=$$($(TF) output -raw ecr_repo_name); \
	TMP=$$(mktemp -d); \
	(cd app && zip -qr "$$TMP/app.zip" . -x "node_modules/*"); \
	aws s3 cp "$$TMP/app.zip" "s3://$$SRC_BUCKET/source/app.zip" --no-cli-pager; \
	rm -rf "$$TMP"; \
	BUILD_ID=$$(aws codebuild start-build --project-name "$$PROJECT" --query 'build.id' --output text); \
	echo "codebuild started: $$BUILD_ID"; \
	while :; do \
	  STATUS=$$(aws codebuild batch-get-builds --ids "$$BUILD_ID" --query 'builds[0].buildStatus' --output text); \
	  echo "  build $$STATUS"; \
	  [ "$$STATUS" != "IN_PROGRESS" ] && break; \
	  sleep 15; \
	done; \
	[ "$$STATUS" = "SUCCEEDED" ] || { echo "build failed — logs: aws logs tail /aws/codebuild/ctr-image-build"; exit 1; }; \
	echo "waiting for ECR scan-on-push…"; \
	for i in $$(seq 1 20); do \
	  SCAN=$$(aws ecr describe-image-scan-findings --repository-name "$$REPO" --image-id imageTag=latest \
	    --query 'imageScanStatus.status' --output text 2>/dev/null || echo PENDING); \
	  [ "$$SCAN" = "COMPLETE" ] || [ "$$SCAN" = "ACTIVE" ] && break; \
	  sleep 10; \
	done; \
	aws ecr describe-image-scan-findings --repository-name "$$REPO" --image-id imageTag=latest \
	  --query 'imageScanFindings.findingSeverityCounts' --output json --no-cli-pager 2>/dev/null || true; \
	echo "image pushed + scanned: $$($(TF) output -raw ecr_repo_url):latest"

verify:
	./scripts/verify.sh

outputs:
	@$(TF) output

destroy:
	$(TF) destroy -auto-approve
