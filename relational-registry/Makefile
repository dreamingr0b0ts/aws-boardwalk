SHELL := /bin/bash
ACCOUNT := $(shell aws sts get-caller-identity --query Account --output text)
STATE_BUCKET := aws-boardwalk-tfstate-$(ACCOUNT)
TF := terraform -chdir=infra
TFD := terraform -chdir=demo
DEMO_VARS := -var="state_bucket=$(STATE_BUCKET)"

.PHONY: init deploy publish verify outputs destroy init-demo demo seed report status teardown write-status

# ── always-on half (site + query API + persisted evidence) — CI applies this ─

init:
	$(TF) init -backend-config="bucket=$(STATE_BUCKET)" -input=false

deploy: init
	$(TF) apply -auto-approve -input=false
	$(MAKE) publish

## Upload the frontend, then invalidate. evidence/ belongs to the report
## Lambda and the demo lifecycle — never let a site sync delete it.
publish:
	@BUCKET=$$($(TF) output -raw site_bucket); \
	DIST=$$($(TF) output -raw distribution_id); \
	aws s3 sync frontend "s3://$$BUCKET" --delete --exclude "evidence/*"; \
	aws cloudfront create-invalidation --distribution-id "$$DIST" --paths "/*" --no-cli-pager --output text > /dev/null; \
	echo "published → $$($(TF) output -raw site_url)"

verify:
	./scripts/verify.sh

outputs:
	@$(TF) output

destroy:
	$(TF) destroy -auto-approve

# ── teardown half (the Aurora Serverless v2 cluster) ─────────────────────────
# RDS is banned always-on, so the cluster exists only between `make demo` and
# `make teardown`. This root is deliberately NOT in the CI matrix. Even while
# deployed it auto-pauses to 0 ACU after 5 idle minutes.

init-demo:
	$(TFD) init -backend-config="bucket=$(STATE_BUCKET)" -input=false

## Deploy the cluster (~10 min), run migrations + seed, generate evidence.
demo: init-demo
	$(TFD) apply -auto-approve -input=false $(DEMO_VARS)
	$(MAKE) seed
	$(MAKE) report
	$(MAKE) write-status DEPLOYED=true
	@echo ""
	@echo "Aurora demo stack LIVE — exhibits at $$($(TF) output -raw site_url)"
	@echo "idle it auto-pauses to 0 ACU; 'make teardown' when the demo window is over."

## Apply migrations + regenerate seed data (idempotent; FORCE=1 reruns the seed).
seed:
	@FN=$$($(TFD) output -raw seed_function); \
	OUT=$$(mktemp); \
	aws lambda invoke --function-name "$$FN" --cli-read-timeout 320 \
	  --cli-binary-format raw-in-base64-out --payload '{"force":$(if $(FORCE),true,false)}' \
	  --no-cli-pager "$$OUT" > /dev/null; \
	cat "$$OUT" | python3 -m json.tool; rm -f "$$OUT"

## Regenerate evidence.json + evidence.html from the live cluster.
report:
	@FN=$$($(TFD) output -raw report_function); \
	OUT=$$(mktemp); \
	aws lambda invoke --function-name "$$FN" --cli-read-timeout 320 --no-cli-pager "$$OUT" > /dev/null; \
	cat "$$OUT" | python3 -m json.tool; rm -f "$$OUT"

## Final evidence snapshot, then destroy the cluster and every daily-billing
## resource. The site keeps serving the last report; the query API answers 503.
teardown:
	-$(MAKE) report
	$(TFD) destroy -auto-approve $(DEMO_VARS)
	$(MAKE) write-status DEPLOYED=false
	@echo "Aurora stack torn down — the evidence report remains on the site."

## Internal: status.json drives the page's LIVE / torn-down banner.
write-status:
	@BUCKET=$$($(TF) output -raw site_bucket); \
	printf '{"deployed":%s,"updatedAt":"%s"}' "$(DEPLOYED)" "$$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /tmp/rdb-status.json; \
	aws s3 cp /tmp/rdb-status.json "s3://$$BUCKET/evidence/status.json" \
	  --content-type application/json --cache-control no-cache --no-cli-pager; \
	rm -f /tmp/rdb-status.json

status:
	@COUNT=$$($(TFD) state list 2>/dev/null | wc -l | tr -d ' '); \
	if [ "$$COUNT" -gt 0 ]; then \
	  echo "demo stack: DEPLOYED (auto-pauses to 0 ACU when idle — 'make teardown' when done)"; \
	else \
	  echo "demo stack: torn down (idle ≈ \$$0)"; \
	fi
