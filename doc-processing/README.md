# Plank 7 — Intelligent Document Processing

**Live:** https://documents.demos.planetek.org

Drop any PDF or image into the pipeline and watch it become structured, searchable data:

```
presigned POST → S3 incoming/ → EventBridge → Step Functions
  ├─ RegisterAndStartOcr   validate size/type/page-cap, start Textract FORMS (async)
  ├─ WaitForOcr ⟳ PollOcr  poll the job; parse text + key/value pairs; stash full
  │                        extraction in S3, summary metadata in DynamoDB
  ├─ DetectEntities        Comprehend entities + PII flag
  ├─ ClassifyDocument      Claude Haiku on Bedrock → type, title, summary, date
  ├─ IndexDocument         record flips to INDEXED (uploads get a 72h TTL)
  └─ MarkFailed            any failure → direct DynamoDB update, no zombie PROCESSING
```

The frontend is a zero-build static page: a **public, free-to-browse faceted index**
(DynamoDB reads only) over the seeded corpus of eight fictional City of Alpenglow
documents, plus a **Cognito-gated upload panel** that shows the pipeline advancing
step by step against the document's own timeline.

## Cost posture (same philosophy as plank 6, tuned for Textract)

Textract FORMS is the expensive unit (~$0.05/page), so the caps bound **pages**, not
just requests:

1. **Cognito JWT gate** — no anonymous uploads, self-signup disabled, credential never
   printed or committed (`make creds-show`; CI reads SSM `/boardwalk/doc-processing/demo-password`).
2. **Size cap (4 MB)** — enforced in the presigned POST conditions *and* re-checked in the pipeline.
3. **Page cap (6)** — the PDF is parsed and counted **before** any Textract job starts.
4. **Per-user daily cap (8 docs)** and **global daily kill switch (20 docs)** — atomic
   DynamoDB counters checked before a presigned POST is ever issued.
5. **Edge throttle** (5 rps) on the API stage.

Worst case with a leaked credential: 20 docs × 6 pages × $0.05 ≈ **$6/day**, plus
Comprehend/Bedrock pennies. Idle: **~$0** (all pay-per-use services).

Uploads are purged nightly at 09:00 UTC (`idp-reset`, also `make reset`); item TTL is
the backstop. Seeds are permanent.

## Targets

| target | what |
|---|---|
| `make deploy` | bundle Lambdas, apply Terraform, publish frontend, seed corpus |
| `make seed` | regenerate the fictional PDFs and push them through the live pipeline |
| `make verify` | 24-check end-to-end suite against the live URL (includes a real upload round trip and cap/abuse checks) |
| `make creds-show` | print the demo credential (never published) |
| `make reset` | purge uploaded demo documents now |
| `make destroy` | tear the plank down |

## Swappability

The corpus is just PDFs: `corpus/generate.mjs` builds the fictional Alpenglow set, but
any documents dropped under `incoming/` flow through the same pipeline — point it at a
real records series (with real caps raised) and the same bones do DMS/records-
modernization work.
