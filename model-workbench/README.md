# Plank 12 — Alpenglow Model Workbench (Bedrock foundation models)

**Live:** https://models.demos.planetek.org · prefix `fmw-`

A foundation-model **evaluation workbench**: one prompt goes to four models from four
vendors — Claude Haiku 4.5 (Anthropic), Nova Lite (Amazon), Llama 3.3 70B (Meta),
Pixtral Large (Mistral) — through the **single Bedrock Converse API**, in parallel, and
comes back side by side with measured latency, token usage, and computed cost. Every
run lands in a DynamoDB **audit ledger** (who, what, which models, which parameters,
what it cost) — the explainable accountability trail responsible-AI policies ask for.

The scenario library is shaped like the public-sector GenAI work in Planetek's
pipeline: plan-review triage against code excerpts, grounded code Q&A with a
deliberate **refusal test** (which models admit "the excerpt doesn't say"?),
determination letters, structured extraction to strict JSON, plain-language rewrites.

## Cost guardrails (plank 6's pattern — this surface spends real tokens)

- Bedrock is pay-per-use: **idle cost $0**, so the plank is always-on and in CI.
- Credential NEVER printed on the site or committed (`.demo-creds`, synced to SSM
  `/boardwalk/model-workbench/demo-password` for keyless CI); self-signup disabled.
- Per-user 30 runs/day + global 120 runs/day (DynamoDB conditional counters), hard
  500-output-token ceiling, 2,000-char prompt cap, 5 rps edge throttle, noindex.
- Worst-case leaked-credential day: 120 runs × 4 models ≈ **$2-3**.
- The run role's IAM allows `bedrock:InvokeModel` on exactly the four roster
  profiles; the public route's role has no Bedrock permissions at all.

## Layout

- `infra/` — single always-on Terraform root (state key `model-workbench.tfstate`)
- `infra/lambda/` — plain-ESM handlers, one zip: `run.mjs` (fan-out + ledger),
  `public.mjs` (anonymous roster/stats), `scenarios.mjs` (shared library)
- `frontend/` — zero-build static UI (Cognito InitiateAuth, same-origin `/api/*`)

## Commands

```
make deploy      # apply + publish (CI also applies on push)
make creds-show  # print the demo credential (never published)
make verify      # 20-check suite incl. guardrails; costs well under a cent
make destroy
```
