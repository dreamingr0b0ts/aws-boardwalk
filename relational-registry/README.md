# Plank 11: Alpenglow Land & Records Registry (relational database)

**Live:** https://registry.demos.planetek.org · prefix `rdb-`

The relational core every submit→review→decide system needs, built the only way a
database fits this portfolio's cost rules: **Aurora Serverless v2 PostgreSQL 17 that
scales to zero** (0 ACU floor, 5-minute auto-pause), reached exclusively through the
**RDS Data API** (HTTPS + IAM + Secrets Manager; the cluster's security group has zero
rules), and torn down entirely between demo windows.

## Two Terraform roots (same pattern as planks 8 & 9)

| root | state key | lifecycle | contents |
|---|---|---|---|
| `infra/` | `relational-registry.tfstate` | always on, in the CI matrix | site + CloudFront, HTTP API + `rdb-query-api` Lambda, DynamoDB usage counter, persisted `evidence/` |
| `demo/` | `relational-registry-demo.tfstate` | `make demo` / `make teardown`, **never in CI** | Aurora cluster + instance, app-user secret, SSM discovery params, seed + report Lambdas |

The always-on query Lambda discovers the cluster through SSM parameters the demo root
writes; between windows the parameters are gone and the API answers 503 honestly while
the page serves the persisted evidence report.

## Exhibits (all canned SQL; no user SQL surface exists)

- **Scale to zero:** any exhibit wakes a paused cluster; the API returns 202 while Aurora
  resumes and the page times the wake (~15s), then shows it cost $0 while paused.
- **Reads:** three-table join, `permit_throughput` + `contractor_scorecard` views over a
  ~20k-row registry generated in-engine (`generate_series`) by the migration Lambda.
- **Integrity:** FK violation, CHECK violation, and an atomic two-step transfer that
  rolls back, engine error messages shown verbatim; every write exhibit runs inside a
  transaction that is always rolled back.
- **Least privilege:** the API connects as `app_user` (SELECT on registry, writes only in
  the rollback sandbox); its own DELETE and DROP attempts dying is an exhibit.
- **Plans:** `EXPLAIN ANALYZE` index scan vs seq scan, live planner output.
- **Schema as code:** ordered, checksummed migrations recorded in `schema_migrations`.

## Cost guardrails

- RDS is banned always-on → the whole cluster is deploy-demo-teardown; idle between
  windows ≈ $0 (evidence report + static site only).
- While deployed: min 0 ACU/auto-pause 300s → compute is $0 whenever nobody is looking;
  worst case (kept awake all day at the 1 ACU cap) ≈ $3/day.
- Edge throttle 5 rps + a global daily counter (400 exhibit runs) bounds how long
  strangers can keep the cluster awake. Queries themselves are canned and parameterless.

## Design: "The County Vault"

The plank wears the Alpenglow County recorder's deed vault. Aurora sealing itself at
0 ACU is the vault sealing five idle minutes after the last reader leaves; the timed
202-retry wake is the unsealing; the persisted evidence report is the certified copy
left on the public counter between windows. Exhibits are request slips presented at
the counter, constraint violations are the recorder refusing a defective instrument,
EXPLAIN is the tract index versus turning every page, and the checksummed migrations
are wax-sealed amendments in the migration ledger.

- Light mode: the recording desk. Aged ledger cream, iron-gall ink, sealing-wax red,
  aged brass; every panel carries a ledger margin rule.
- Dark mode: inside the sealed vault. Cold iron surfaces, parchment text, brass
  glints; the section plates stay paper, like real labels on dark spines.
- Type: Besley (a Clarendon, the record-book voice) with Fragment Mono as the
  typewritten-form voice for readouts, labels, and SQL. Self-hosted woff2 in
  `frontend/fonts/` (the CSP allows no font CDNs).
- Motifs: gold-tooled divider rules, spine-label section plates (Book 01…05),
  stamp-styled badges (TORN DOWN) and refusal/recording boxes, a brass vault-dial
  favicon, and a matching certified-copy treatment on the standalone
  `evidence.html` the report Lambda renders.
- Photos (Unsplash free license, self-hosted): vault door by Alex Duffy (hero + og),
  archive volumes with hand-lettered spine labels by Catarina Carvalho (interlude).

## Commands

```
make deploy     # always-on half (CI also applies this on push)
make demo       # cluster + migrations + seed + evidence (~15 min)
make seed       # re-run migrations (FORCE=1 regenerates data)
make report     # refresh evidence.json / evidence.html
make verify     # two-mode suite: live exhibits, or proof of $0 idle
make teardown   # final evidence, then destroy every billing resource
```
