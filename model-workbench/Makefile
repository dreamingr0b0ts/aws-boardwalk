SHELL := /bin/bash
ACCOUNT := $(shell aws sts get-caller-identity --query Account --output text)
STATE_BUCKET := aws-boardwalk-tfstate-$(ACCOUNT)
TF := terraform -chdir=infra
CREDS := .demo-creds

.PHONY: init creds creds-show deploy publish verify outputs destroy

init:
	$(TF) init -backend-config="bucket=$(STATE_BUCKET)" -input=false

## Generate the demo password once, locally, never committed. Like planks 6/7
## the credential is NOT printed on the site — the owner hands it out.
creds:
	@if [ ! -f $(CREDS) ]; then \
		echo "Demo-$$(openssl rand -hex 8)-Xk9!" > $(CREDS); \
		chmod 600 $(CREDS); \
		echo "generated new demo credential in $(CREDS)"; \
	fi
	@aws ssm put-parameter --name /boardwalk/model-workbench/demo-password \
		--type SecureString --value "$$(cat $(CREDS))" --overwrite > /dev/null; \
	echo "SSM parameter /boardwalk/model-workbench/demo-password in sync (lets keyless CI plan/apply this plank)"

creds-show: creds
	@echo "url:      https://$$($(TF) output -raw site_url 2>/dev/null | sed 's|https://||' || echo models.demos.planetek.org)"; \
	echo "email:    $$($(TF) output -raw demo_email 2>/dev/null || echo workbench@demo.planetek.org)"; \
	echo "password: $$(cat $(CREDS))"

## Full deployment: apply infra, publish frontend + runtime config
deploy: init creds
	TF_VAR_demo_password="$$(cat $(CREDS))" $(TF) apply -auto-approve -input=false
	$(MAKE) publish

## Upload frontend + runtime config, then invalidate CloudFront
publish:
	@BUCKET=$$($(TF) output -raw site_bucket); \
	DIST=$$($(TF) output -raw distribution_id); \
	$(TF) output -json | jq '{region: "us-east-1", userPoolClientId: .user_pool_client_id.value}' \
		> frontend/config.json; \
	aws s3 sync frontend "s3://$$BUCKET" --delete; \
	aws cloudfront create-invalidation --distribution-id "$$DIST" --paths "/*" --no-cli-pager --output text > /dev/null; \
	echo "published → $$($(TF) output -raw site_url)"

verify:
	./scripts/verify.sh

outputs:
	@$(TF) output

destroy:
	TF_VAR_demo_password="$$(cat $(CREDS))" $(TF) destroy -auto-approve
