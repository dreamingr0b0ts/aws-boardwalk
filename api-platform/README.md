# Plank 2 — API & Microservices (`api-platform/`)

**Live: https://api.demos.planetek.org** · fictional City of Alpenglow developer API

A documented public REST API built the way integrators expect to meet one:
versioned endpoints with an honest deprecation story, API keys on usage plans
with throttles and daily quotas, request bodies validated by the gateway
before any code runs, and per-service Lambdas with real ownership boundaries.

## The spec is the system

`infra/openapi.yaml` is the single source of truth:

- **Terraform imports it into API Gateway** (`aws_api_gateway_rest_api.body`,
  yamldecode→jsonencode so a typo fails at plan time). All routes, models,
  validators, mock integrations, and gateway responses live in the spec —
  there are no `aws_api_gateway_resource`/`method` resources to drift from it.
- **`make publish` renders the same file to the docs page** as
  `/openapi.json`, stripping the `x-amazon-apigateway-*` wiring. The docs
  cannot disagree with the deployed gateway.

## What it demonstrates

| Exhibit | Where |
|---|---|
| Versioning + deprecation | `/v1/*` still answers, with `Deprecation`, `Sunset`, and successor-version `Link` headers; `/v2/*` adds cursor pagination + filtering |
| API keys & usage plans | demo tier (2 req/s, burst 5, 2,500/day — key printed on the docs page) vs partner tier (25 req/s, 50,000/day — never published) metering the identical API |
| Request validation | `POST /v2/permits/{id}/inspections` bodies are checked against a JSON-schema model **by the gateway** — invalid payloads 400 before any Lambda runs |
| Microservice boundaries | permits / licenses / facilities are separate Lambdas; each IAM role reaches only its own DynamoDB table (status λ gets table *metadata* only) |
| Gateway responses | missing key → friendly 403, unknown path → honest 404, throttle/quota → distinct 429s, all JSON |
| Mock integration | `/v1/ping` is answered by API Gateway itself — zero compute |

REST API Gateway (not HTTP API) on purpose: keys, usage plans, and
model validation only exist on the REST flavor — they are the exhibit.

## Architecture

```
docs (S3 + CloudFront, OAC) ── same origin ──> /v1/* /v2/* ──> API Gateway REST "live" stage
                                                                │  keys · plans · validator · mock
                                                    ┌───────────┼───────────┬────────────┐
                                                permits λ   licenses λ  facilities λ  status λ
                                                    │           │            │        (DescribeTable
                                              apx-permits  apx-licenses apx-facilities   only)
```

Same-origin API under the real versioned paths — no CORS anywhere. Visitor
writes (inspection requests) carry a 24h DynamoDB TTL, so the only mutable
surface self-cleans; the seed catalog (240 permits, 160 licenses, 24
facilities — all fictional, deterministic ids) persists.

## Cost & abuse posture

Public by design, like plank 3: nothing behind the API costs real money per
request, so the demo key is printed on the docs page. The usage plans bound
nuisance (worst case ≈ 2,500 req/day ≈ $0.01), a stage-wide 25 req/s throttle
walls the keyless routes, and idle cost is ~$0.

## Operating it

```
make deploy    # bundle handlers, terraform apply, publish docs, seed catalogs
make publish   # docs site + rendered openapi.json + config.json (demo key from state)
make seed      # idempotent re-seed of the three service catalogs
make verify    # 35 end-to-end checks against the live URL
make destroy
```

## Design

Plank identity: **"the city exchange"** — the API gateway as Alpenglow's
telephone switchboard. The board answers, refuses, and meters every call
before an office picks up, which is an API gateway's whole job: the no-key
403 is the operator refusing a call, a 429 is the busy signal, the demo tier
is the party line and the partner tier a private trunk, and the v1
Deprecation/Sunset headers are the old exchange being retired with notices
posted while calls still connect.

- **Palette**: ebonite black-brown board, copper cords and hairlines, jade
  indicator lamps for held calls, amber for busy signals. Light mode is the
  exchange room by day (warm plaster, stamped line-number plates); dark mode
  is the night board. Code blocks stay ebonite in both schemes.
- **Type**: Jost (Futura-flavored, 1930s exchange signage) for display and
  body; JetBrains Mono for the operator's log, readouts, and code. Static
  woff2 vendored in `frontend/fonts/` (the CSP allows no font CDNs).
- **Motifs**: a jack-strip of copper sockets closes the hero and tops the
  footer; sections carry stamped "Line 01…05" plates; status lines and the
  burst demo render as indicator lamps; architecture nodes get jack rings.
- **Photos** (free Unsplash licenses, self-hosted webp): hero is Dave
  Meckler's patch-cord jack field at the Georgetown Steam Plant, Seattle;
  the interlude is the Smithsonian Institution's Telephone and Telegraph
  Office in the North Tower of the United States National Museum (public
  domain). Credits in the footer.
