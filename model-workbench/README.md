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
determination letters, structured extraction to strict JSON, plain-language rewrites,
and a **guardrail exhibit** (a complaint full of fake PII, run raw vs through a
Bedrock Guardrail that masks emails/phones/SSNs and denies legal-advice topics).

Three evaluation layers on every comparison:

- **Blind judge:** one extra call to the cheapest roster model scores each answer
  1-10 against the scenario's written rubric; answers are shuffled and anonymized
  (A-D) so the judge cannot favor a vendor. The judge's own tokens and cost are
  metered and land in the ledger.
- **Deterministic grading:** the extraction scenario is also graded by plain code
  in the frontend: strict parse vs fenced vs chat-wrapped, then schema validation.
- **Bench records:** a public 30-day per-model record (runs, median latency, avg
  cost) aggregated from the audit ledger, drawn as one latency sparkline per model.

**Two tiers.** Visitors get **5 free runs a day with no sign-in** — scenario-library
prompts only, counted per hashed IP, drawn from a 40-run/day anonymous pool. Signing
in (unpublished credential) unlocks 30 runs/day, custom prompts, the 500-token
ceiling, and the ledger view.

## Cost guardrails (plank 6's pattern — this surface spends real tokens)

- Bedrock is pay-per-use: **idle cost $0**, so the plank is always-on and in CI.
- Credential NEVER printed on the site or committed (`.demo-creds`, synced to SSM
  `/boardwalk/model-workbench/demo-password` for keyless CI); self-signup disabled.
- Visitor tier is fenced: scenario prompts only (nothing a stranger types reaches a
  model), 5 runs/day per hashed IP + a 40-run/day anonymous pool, 300-token ceiling.
  Visitor runs ALSO count against the global cap, so the free tier raised the
  worst-case day by $0.
- Per-user 30 runs/day + global 120 runs/day (DynamoDB conditional counters), hard
  500-output-token ceiling, 2,000-char prompt cap, 5 rps edge throttle, noindex.
- The judge call (Nova Lite, 400-token cap) and the optional guardrail ride inside
  the same run counters; both add well under a cent per run.
- Worst-case leaked-credential day: 120 runs × 4 models ≈ **$2-3**.
- The run role's IAM allows `bedrock:InvokeModel` on exactly the four roster
  profiles plus `bedrock:ApplyGuardrail` on the one workbench guardrail; the
  public routes' role has no Bedrock permissions at all (bench records are pure
  DynamoDB reads of counts and timings, never prompts or identities).

## Layout

- `infra/` — single always-on Terraform root (state key `model-workbench.tfstate`)
- `infra/lambda/` — plain-ESM handlers, one zip: `run.mjs` (fan-out + ledger),
  `public.mjs` (anonymous roster/stats), `scenarios.mjs` (shared library)
- `frontend/` — zero-build static UI (Cognito InitiateAuth, same-origin `/api/*`)

## Design

Plank identity: the signal bench. Four models are four oscilloscope channels (CH1 amber ·
CH2 cyan · CH3 magenta · CH4 green), color-coded everywhere a model appears — roster cards,
model pickers, result cards, the ledger. Graphite instrument-panel dark mode with phosphor-green
readouts; light mode is a daylight metrology lab on graph-paper rulings (never plain white).
Type: [Space Grotesk](https://github.com/floriankarsten/space-grotesk) (display) and
[IBM Plex Mono](https://github.com/IBM/plex) (readouts), both OFL, vendored as static woff2 in
`frontend/fonts/` — the CSP allows only self-hosted assets.

Photography (Unsplash license, resized via CDN params, self-hosted in `frontend/images/`):
hero is a long-exposure RGB light-painting of waveforms by
[Mitchell Y](https://unsplash.com/photos/bxE-z_T87c0); the mid-page interlude is a 1922
lantern slide of hand-drawn wave traces ("comparing wave shapes" is a century-old bench
practice) preserved by
[Auckland War Memorial Museum Tāmaki Paenga Hira](https://unsplash.com/photos/c7izR0O9cOE).

## Commands

```
make deploy      # apply + publish (CI also applies on push)
make creds-show  # print the demo credential (never published)
make verify      # 20-check suite incl. guardrails; costs well under a cent
make destroy
```
