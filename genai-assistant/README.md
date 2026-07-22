# Plank 6 — Generative AI (RAG) · Alpenglow Records Assistant

Live: **https://assistant.demos.planetek.org**

A retrieval-augmented assistant over a swappable document corpus (demo domain: the fictional
City of Alpenglow's permitting & licensing handbook, which ties into plank 1's permit portal).
Citation-grounded answers, confidence display, prompt guardrails, conversation logging, and a
human-feedback loop — the responsible-AI pattern set, built free-tier-first.

## Architecture

```
Browser ── CloudFront (HSTS/CSP, X-Robots-Tag: noindex)
   │            ├── S3 (static page, OAC-locked)
   │            └── /api/* ── HTTP API (edge throttle 5 rps)
   │                             ├── GET /api/public/info ──► public λ ──► S3 index/meta.json only
   │                             └── JWT authorizer (Cognito) ──► chat λ
   │                                    1. per-user daily counter (DynamoDB, conditional ADD)
   │                                    2. global daily kill switch (DynamoDB, conditional ADD)
   │                                    3. Titan v2 embed query ──► cosine top-4 over S3 vector index
   │                                    4. Claude Haiku 4.5 (Bedrock) with cited-passages-only prompt
   │                                    5. conversation log (DynamoDB, TTL 7d)
   └── Cognito (no self-signup, admin-created users only)

ingest λ (make corpus): corpus/*.md ──► chunk by H2 ──► Titan v2 ──► index/vectors.json
```

## Why nobody can burn tokens for free

The spec for this plank is "Cognito gate (no anonymous token burn)" — implemented as four
layers, so no single failure exposes the Bedrock bill:

1. **No anonymous surface.** Every route that can reach Bedrock requires a valid Cognito JWT.
   The one public route serves static corpus metadata and its Lambda role can't call Bedrock.
2. **No way in without the owner.** Self-signup is disabled (`allow_admin_create_user_only`),
   and — deliberately unlike plank 1 — the demo credential is *not* printed on the login page
   or committed to this repo. It lives in the untracked `.demo-creds` file and is handed out
   during demos (`make creds-show`).
3. **Hard caps even for valid logins.** Per-user daily cap (default 40 messages) and a global
   daily kill switch (default 200) enforced with DynamoDB conditional atomic counters, plus
   API-edge throttling (5 rps), capped input length, capped history, and capped `max_tokens`.
   Worst case if a credential leaks: ~$2/day, inside the account's $35 budget tripwire.
4. **Not discoverable.** `robots.txt` disallows all crawling and CloudFront stamps
   `X-Robots-Tag: noindex, nofollow` on every response.

`make verify` proves the guardrails live: anonymous 401, signup NotAuthorizedException, and a
forced-counter 429.

## Cost profile

Idle: **$0** (S3 + DynamoDB on-demand + Lambda — all in perpetual free tier or pennies).
Per demo session: Haiku 4.5 at ~3K input / ~0.4K output tokens per message ≈ **half a cent per
message**; Titan embeddings are ~$0.0001 per corpus re-index. Global cap bounds the worst day
at about $2.

## Swapping the corpus

The corpus is a folder of markdown files. To re-skin for a pursuit (building codes, HR policy,
grant guidelines):

```sh
rm corpus/*.md && cp ~/pursuit-docs/*.md corpus/
make corpus   # syncs to S3 + re-embeds + atomically replaces the index
```

Chunking is by `##` heading (split at ~1400 chars); each chunk is embedded with its document
title and section name for context.

## Design

Plank identity: the records office that answers at midnight. Nocturne palette (indigo night,
amber lamplight, violet starlight), [Spectral](https://github.com/productiontype/Spectral) (OFL)
as the display serif, a constellation motif in the hero (retrieval as connecting stars), and
serif "handbook excerpt" styling for assistant answers. Dark is the primary mood; light renders
as a dawn reading room. The CSP allows only self-hosted assets, so the fonts (static woff2 in
`frontend/fonts/`) and photography ship from the site bucket.

Hero photo: snow peak under the Milky Way by [Benjamin Voros](https://unsplash.com/photos/phIFdC6lA4E)
(Unsplash license), resized via CDN params and self-hosted in `frontend/images/`.

## Operations

```sh
make deploy      # build lambdas, terraform apply, publish site, load corpus
make creds-show  # demo URL + credential (never committed; .demo-creds is gitignored)
make corpus      # re-sync + re-embed the corpus
make verify      # 16 end-to-end checks against the live URL
make destroy     # tear down (corpus + site buckets force_destroy)
```

Demo data note: the City of Alpenglow is fictional; all fees/rules in `corpus/` are invented
for demonstration.
