SHELL := /bin/bash
ACCOUNT := $(shell aws sts get-caller-identity --query Account --output text)
STATE_BUCKET := aws-boardwalk-tfstate-$(ACCOUNT)
TF := terraform -chdir=infra
TFD := terraform -chdir=demo
DEMO_VARS := -var="state_bucket=$(STATE_BUCKET)"

.PHONY: init deploy publish verify outputs destroy init-demo demo report status teardown

# ── always-on half (site + persisted evidence) — CI applies this on push ─────

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
	aws s3 sync frontend "s3://$$BUCKET" --exclude "*" --include "fonts/*" \
	  --cache-control "public, max-age=31536000, immutable"; \
	aws s3 sync frontend "s3://$$BUCKET" --exclude "*" \
	  --include "*.webp" --include "*.jpg" --include "*.png" --include "*.svg" --include "*.ico" \
	  --exclude "fonts/*" --cache-control "public, max-age=86400"; \
	aws s3 sync frontend "s3://$$BUCKET" --delete --exclude "evidence/*" \
	  --cache-control "public, max-age=300, must-revalidate"; \
	aws cloudfront create-invalidation --distribution-id "$$DIST" --paths "/*" --no-cli-pager --output text > /dev/null; \
	echo "published → $$($(TF) output -raw site_url)"

verify:
	./scripts/verify.sh

outputs:
	@$(TF) output

destroy:
	$(TF) destroy -auto-approve

# ── teardown half (Security Hub / Config / the KMS-encrypted trail) ──────────
# These services bill by the day, so they exist only between `make demo` and
# `make teardown`. This root is deliberately NOT in the CI matrix.
# GuardDuty is not one of them any more: the detector is the account's own
# always-on one (plank 10). `make demo` seeds practice findings into it and
# `make teardown` archives them again.

init-demo:
	$(TFD) init -backend-config="bucket=$(STATE_BUCKET)" -input=false

## Deploy the security stack, seed GuardDuty with AWS sample findings, give
## the evaluators a few minutes, then generate the first evidence report.
## Security Hub + Config keep evaluating after this — `make report` any time
## refreshes the evidence (30-60 min in, coverage is much fuller).
demo: init-demo
	$(TFD) apply -auto-approve -input=false $(DEMO_VARS)
	@DETECTOR=$$($(TFD) output -raw detector_id); \
	aws guardduty create-sample-findings --detector-id "$$DETECTOR" --no-cli-pager; \
	echo "practice findings seeded into the account's detector $$DETECTOR"
	@echo "waiting 3 minutes for first evaluations to land…"; sleep 180
	$(MAKE) report
	$(MAKE) write-status DEPLOYED=true
	@echo ""
	@echo "demo stack LIVE: evidence at $$($(TF) output -raw site_url)"
	@echo "re-run 'make report' in ~30-60 min for fuller Security Hub/Config coverage,"
	@echo "and 'make teardown' when the demo window is over (it bills daily until then)."

## Regenerate evidence.json + evidence.html from live findings.
report:
	@FN=$$($(TFD) output -raw report_function); \
	OUT=$$(mktemp); \
	aws lambda invoke --function-name "$$FN" --cli-read-timeout 180 --no-cli-pager "$$OUT" > /dev/null; \
	cat "$$OUT" | python3 -m json.tool; rm -f "$$OUT"

## Final evidence snapshot, archive the practice findings out of the account's
## detector, then destroy every daily-billing resource. The site keeps serving
## the last report; status.json flips to torn-down. Archiving must never block
## the destroy (that is what stops the billing), hence its leading dash.
## The trailing delete handles a race: the report Lambda's final log lines can
## be delivered AFTER terraform destroys its log group, auto-recreating it
## unmanaged (no retention) — which then collides with the next demo's apply.
teardown:
	-$(MAKE) report
	-./scripts/archive-samples.sh
	$(TFD) destroy -auto-approve $(DEMO_VARS)
	$(MAKE) write-status DEPLOYED=false
	@aws logs delete-log-group --log-group-name /aws/lambda/sec-evidence-report 2>/dev/null || true
	@aws logs delete-log-group --log-group-name /aws/lambda/sec-drill-responder 2>/dev/null || true
	@echo "security stack torn down. The evidence report remains on the site."

## Internal: status.json drives the page's LIVE / torn-down banner.
write-status:
	@BUCKET=$$($(TF) output -raw site_bucket); \
	printf '{"deployed":%s,"updatedAt":"%s"}' "$(DEPLOYED)" "$$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /tmp/sec-status.json; \
	aws s3 cp /tmp/sec-status.json "s3://$$BUCKET/evidence/status.json" \
	  --content-type application/json --cache-control no-cache --no-cli-pager; \
	rm -f /tmp/sec-status.json

status:
	@$(TFD) state list 2>/dev/null | grep -q . \
	  && echo "demo stack: DEPLOYED (billing daily; 'make teardown' when done)" \
	  || echo "demo stack: torn down (idle ≈ \$$0)"
