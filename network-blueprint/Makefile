SHELL := /bin/bash
ACCOUNT := $(shell aws sts get-caller-identity --query Account --output text)
STATE_BUCKET := aws-boardwalk-tfstate-$(ACCOUNT)
TF := terraform -chdir=infra
TFD := terraform -chdir=demo
DEMO_VARS := -var="state_bucket=$(STATE_BUCKET)"

.PHONY: init deploy publish verify outputs destroy init-demo demo report status teardown write-status

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
	aws s3 sync frontend "s3://$$BUCKET" --delete --exclude "evidence/*"; \
	aws cloudfront create-invalidation --distribution-id "$$DIST" --paths "/*" --no-cli-pager --output text > /dev/null; \
	echo "published → $$($(TF) output -raw site_url)"

verify:
	./scripts/verify.sh

outputs:
	@$(TF) output

destroy:
	$(TF) destroy -auto-approve

# ── teardown half (VPC, instances, endpoints, flow logs, analyses) ───────────
# Instances + interface endpoints bill hourly, so they exist only between
# `make demo` and `make teardown`. This root is deliberately NOT in the CI
# matrix.

init-demo:
	$(TFD) init -backend-config="bucket=$(STATE_BUCKET)" -input=false

## Build the network (apply also runs the four Reachability Analyzer paths),
## wait for both instances to register with SSM through their respective
## paths (internet vs interface endpoints), give flow logs time to deliver
## their first records, then generate the evidence report.
demo: init-demo
	$(TFD) apply -auto-approve -input=false $(DEMO_VARS)
	@echo "waiting for both instances to register with SSM…"; \
	N=0; \
	for i in $$(seq 1 40); do \
	  N=$$(aws ssm describe-instance-information \
	    --filters "Key=tag:env,Values=network-blueprint" \
	    --query 'length(InstanceInformationList[?PingStatus==`Online`])' --output text); \
	  [ "$$N" = "2" ] && break; sleep 15; \
	done; \
	echo "SSM online: $$N/2"; [ "$$N" = "2" ]
	@echo "waiting 5 minutes for the first flow-log deliveries…"; sleep 300
	$(MAKE) report
	$(MAKE) write-status DEPLOYED=true
	@echo ""
	@echo "network LIVE: evidence at $$($(TF) output -raw site_url)"
	@echo "re-run 'make report' any time for fresh probes and flow-log samples,"
	@echo "and 'make teardown' when the demo window is over (≈\$$0.04/hr until then)."

## Regenerate evidence.json + evidence.html: re-runs the probe suites on the
## instances and re-reads flow logs + analyzer verdicts.
report:
	@FN=$$($(TFD) output -raw report_function); \
	OUT=$$(mktemp); \
	aws lambda invoke --function-name "$$FN" --cli-read-timeout 330 --no-cli-pager "$$OUT" > /dev/null; \
	cat "$$OUT" | python3 -m json.tool; rm -f "$$OUT"

## Final evidence snapshot, then destroy every hourly-billing resource.
## The site keeps serving the last report; status.json flips to torn-down.
teardown:
	-$(MAKE) report
	$(TFD) destroy -auto-approve $(DEMO_VARS)
	$(MAKE) write-status DEPLOYED=false
	@echo "network torn down. The evidence report remains on the site."

## Internal: status.json drives the page's LIVE / torn-down banner.
write-status:
	@BUCKET=$$($(TF) output -raw site_bucket); \
	printf '{"deployed":%s,"updatedAt":"%s"}' "$(DEPLOYED)" "$$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /tmp/net-status.json; \
	aws s3 cp /tmp/net-status.json "s3://$$BUCKET/evidence/status.json" \
	  --content-type application/json --cache-control no-cache --no-cli-pager; \
	rm -f /tmp/net-status.json

status:
	@$(TFD) state list 2>/dev/null | grep -q . \
	  && echo "demo stack: DEPLOYED (billing hourly; 'make teardown' when done)" \
	  || echo "demo stack: torn down (idle ≈ \$$0)"
