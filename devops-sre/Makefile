SHELL := /bin/bash
ACCOUNT := $(shell aws sts get-caller-identity --query Account --output text)
STATE_BUCKET := aws-boardwalk-tfstate-$(ACCOUNT)
TF := terraform -chdir=infra

.PHONY: init deploy publish verify outputs destroy canary-start canary-stop drill

init:
	$(TF) init -backend-config="bucket=$(STATE_BUCKET)" -input=false

## Apply infra, then publish the status page
deploy: init
	TF_VAR_state_bucket="$(STATE_BUCKET)" $(TF) apply -auto-approve -input=false
	$(MAKE) publish

## Upload the status page, then invalidate CloudFront (keeps runbook/ reports)
publish:
	@BUCKET=$$($(TF) output -raw site_bucket); \
	DIST=$$($(TF) output -raw distribution_id); \
	aws s3 sync site "s3://$$BUCKET" --delete --exclude "runbook/*"; \
	aws cloudfront create-invalidation --distribution-id "$$DIST" --paths "/*" --no-cli-pager --output text > /dev/null; \
	echo "published → $$($(TF) output -raw site_url)"

## Start the heartbeat canary for a demo window (~$0.35/day while running)
canary-start:
	aws synthetics start-canary --name "$$($(TF) output -raw canary_name)"
	@echo "canary running: remember 'make canary-stop' after the demo"

canary-stop:
	aws synthetics stop-canary --name "$$($(TF) output -raw canary_name)"
	@echo "canary stopped: idle cost back to ~\$$0"

## Execute the backup/restore drill and print the RTO/RPO report
drill:
	@ARN=$$($(TF) output -raw runbook_state_machine_arn); \
	EXEC=$$(aws stepfunctions start-execution --state-machine-arn "$$ARN" \
		--name "drill-$$(date +%Y%m%d-%H%M%S)" --query executionArn --output text); \
	echo "drill started: $$EXEC"; \
	while :; do \
		STATUS=$$(aws stepfunctions describe-execution --execution-arn "$$EXEC" --query status --output text); \
		[ "$$STATUS" = "RUNNING" ] || break; \
		printf "."; sleep 10; \
	done; echo " $$STATUS"; \
	if [ "$$STATUS" = "SUCCEEDED" ]; then \
		aws stepfunctions describe-execution --execution-arn "$$EXEC" --query output --output text \
			| jq '.verify.report'; \
	else \
		aws stepfunctions describe-execution --execution-arn "$$EXEC" --no-cli-pager; exit 1; \
	fi

verify:
	./scripts/verify.sh

outputs:
	@$(TF) output

destroy:
	TF_VAR_state_bucket="$(STATE_BUCKET)" $(TF) destroy -auto-approve
