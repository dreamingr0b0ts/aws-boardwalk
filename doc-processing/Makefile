SHELL := /bin/bash
ACCOUNT := $(shell aws sts get-caller-identity --query Account --output text)
STATE_BUCKET := aws-boardwalk-tfstate-$(ACCOUNT)
TF := terraform -chdir=infra
CREDS := .demo-creds

.PHONY: init creds creds-show build deploy publish seed verify reset outputs destroy

init:
	$(TF) init -backend-config="bucket=$(STATE_BUCKET)" -input=false

## Generate the demo password once, locally, never committed. Like plank 6 the
## credential is NOT printed on the site — the owner hands it out.
creds:
	@if [ ! -f $(CREDS) ]; then \
		echo "Demo-$$(openssl rand -hex 8)-Xk9!" > $(CREDS); \
		chmod 600 $(CREDS); \
		echo "generated new demo credential in $(CREDS)"; \
	fi
	@aws ssm put-parameter --name /boardwalk/doc-processing/demo-password \
		--type SecureString --value "$$(cat $(CREDS))" --overwrite > /dev/null; \
	echo "SSM parameter /boardwalk/doc-processing/demo-password in sync (lets keyless CI plan/apply this plank)"

creds-show: creds
	@echo "url:      https://$$($(TF) output -raw site_url 2>/dev/null | sed 's|https://||' || echo documents.demos.planetek.org)"; \
	echo "email:    $$($(TF) output -raw demo_email 2>/dev/null || echo documents@demo.planetek.org)"; \
	echo "password: $$(cat $(CREDS))"

build:
	cd backend && npm install --no-fund --no-audit && npm run build

## Full deployment: bundle code, apply infra, publish frontend, seed corpus
deploy: build init creds
	TF_VAR_demo_password="$$(cat $(CREDS))" $(TF) apply -auto-approve -input=false
	$(MAKE) publish
	$(MAKE) seed

## Upload frontend + runtime config, then invalidate CloudFront
publish:
	@BUCKET=$$($(TF) output -raw site_bucket); \
	DIST=$$($(TF) output -raw distribution_id); \
	$(TF) output -json | jq '{region: "us-east-1", userPoolClientId: .user_pool_client_id.value}' \
		> frontend/config.json; \
	aws s3 sync frontend "s3://$$BUCKET" --delete; \
	aws cloudfront create-invalidation --distribution-id "$$DIST" --paths "/*" --no-cli-pager --output text > /dev/null; \
	echo "published → $$($(TF) output -raw site_url)"

## Generate the fictional Alpenglow PDFs and push them through the live
## pipeline (fixtures prefixed "_" are for verify.sh, not the corpus).
seed:
	cd corpus && npm install --no-fund --no-audit && node generate.mjs
	@BUCKET=$$($(TF) output -raw docs_bucket); \
	for f in corpus/pdfs/*.pdf; do \
		name=$$(basename "$$f"); \
		case "$$name" in _*) continue;; esac; \
		slug=$${name%.pdf}; \
		aws s3 cp "$$f" "s3://$$BUCKET/incoming/seed-$$slug/$$name" \
			--metadata source=seed --content-type application/pdf --no-progress; \
	done; \
	echo "seed documents uploaded — pipeline executions are running (make verify waits for INDEXED)"

verify:
	./scripts/verify.sh

## Purge uploaded demo documents now (the same Lambda runs nightly at 09:00 UTC)
reset:
	@OUT=$$(mktemp); \
	aws lambda invoke --function-name "$$($(TF) output -raw reset_function)" \
		--cli-binary-format raw-in-base64-out --payload '{}' \
		--no-cli-pager "$$OUT" > /dev/null; \
	cat "$$OUT"; echo; rm -f "$$OUT"

outputs:
	@$(TF) output

destroy:
	TF_VAR_demo_password="$$(cat $(CREDS))" $(TF) destroy -auto-approve
