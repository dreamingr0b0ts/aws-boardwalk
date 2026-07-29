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
documents, an **upload panel** that shows the pipeline advancing step by step against
the document's own timeline, and three under-glass exhibits on every document:

- **Extraction geometry** — the original renders in-page (self-hosted pdf.js for
  PDFs, canvas for images) with Textract's bounding boxes drawn on top; hover an
  extracted field and see the exact spot on the page it was read from.
- **Redaction desk** — Comprehend `DetectPiiEntities` offsets are mapped through the
  OCR word map back onto the page as labeled black bars (the record stores only PII
  *types and geometry*, never the detected values), with a redacted-page PNG download.
  This is the pass a records office runs before releasing a copy under an
  open-records request.
- **Processing receipt** — an itemized bill per document: Textract pages, Comprehend
  units, Bedrock tokens, priced to the fraction of a cent from Terraform-sourced
  rates.

## Two upload tiers

1. **Anonymous taste tier** (`POST /api/public/uploads`) — 5 documents/day per
   sha256-hashed viewer IP (second-from-last X-Forwarded-For entry, the same fence
   planks 6 and 12 use) plus a 10/day anonymous pool. Anonymous documents are
   **private to the uploader**: they never appear in the public index or stats, the
   unguessable full-UUID docId is the only key to them (kept in the uploader's
   localStorage), and they carry a 24h TTL.
2. **Credentialed tier** (`POST /api/uploads`, Cognito JWT) — 15 documents/day,
   filed in the public index. Self-signup disabled, credential never printed or
   committed (`make creds-show`; CI reads SSM `/boardwalk/doc-processing/demo-password`).

## Cost posture (same philosophy as plank 6, tuned for Textract)

Textract FORMS is the expensive unit (~$0.05/page), so the caps bound **pages**, not
just requests:

1. **Size cap (4 MB)** — enforced in the presigned POST conditions *and* re-checked in the pipeline.
2. **Page cap (6)** — the PDF is parsed and counted **before** any Textract job starts.
3. **Per-tier daily caps** (5/visitor, 10 anonymous pool, 15/user) and a **global
   daily kill switch (30 docs)** — atomic DynamoDB counters checked before a
   presigned POST is ever issued. Anonymous uploads count into the same global cap,
   so the taste tier added reach without adding worst-case spend beyond the cap raise.
4. **Edge throttle** (5 rps) on the API stage, plus the shared WAF per-IP rate limit.

Worst case: 30 docs × 6 pages × $0.05 ≈ **$9/day**, plus Comprehend/Bedrock pennies.
Idle: **~$0** (all pay-per-use services).

Uploads are purged nightly at 09:00 UTC (`idp-reset`, also `make reset`); item TTL is
the backstop (72h credentialed, 24h anonymous). Seeds are permanent.

## Targets

| target | what |
|---|---|
| `make deploy` | bundle Lambdas, apply Terraform, publish frontend, seed corpus |
| `make seed` | regenerate the fictional PDFs and push them through the live pipeline |
| `make verify` | 44-check end-to-end suite against the live URL (includes credentialed AND anonymous upload round trips, geometry/redaction/receipt exhibits, and cap/abuse checks; spends 1 of the machine's 5 daily visitor uploads) |
| `make creds-show` | print the demo credential (never published) |
| `make reset` | purge uploaded demo documents now |
| `make destroy` | tear the plank down |

## Design

Plank identity: the records annex. A municipal archive mid-digitization — manila-folder
document cards (with tabs), rubber-stamp badges and section labels, brass catalog
hardware, faint ledger ruling on the page ground. Light mode is the reading room
(manila cream, iron-gall ink); dark mode is the microfilm room (espresso wood, lamplit
brass). Machine-read text (OCR previews, extracted values, metadata) speaks
[Courier Prime](https://github.com/quoteunquoteapps/CourierPrime); the archive speaks
[Ibarra Real Nova](https://github.com/fontsource) — both OFL, vendored as static woff2
in `frontend/fonts/` (the CSP allows only self-hosted assets).

Photography (Unsplash license, resized via CDN params, self-hosted in `frontend/images/`):
hero is an espresso card catalog with brass pulls by
[Erol Ahmed](https://unsplash.com/photos/Y3KEBQlB1Zk); the mid-page interlude is a
honey-oak catalog by [Jan Antonin Kolar](https://unsplash.com/photos/lRoX0shwjUQ) —
"the previous system of record" the pipeline replaces.

In-page PDF rendering is [pdf.js](https://mozilla.github.io/pdf.js/) (Apache-2.0),
vendored as `frontend/vendor/pdf{,.worker}.min.mjs` — the CSP allows only self-hosted
assets, and `make publish` re-tags the `.mjs` objects `text/javascript` because module
`import()` refuses S3's octet-stream guess.

## Swappability

The corpus is just PDFs: `corpus/generate.mjs` builds the fictional Alpenglow set, but
any documents dropped under `incoming/` flow through the same pipeline — point it at a
real records series (with real caps raised) and the same bones do DMS/records-
modernization work.
