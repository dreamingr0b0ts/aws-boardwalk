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

## Exhibits (canned SQL or bound parameters; no user SQL surface exists)

- **The seal watch:** a live instrument over scale-to-zero. Capacity trace from CloudWatch
  (last 3 hours), a ticking countdown from the last Data API touch to the auto-pause, and a
  wake ledger in DynamoDB: every measured unsealing goes on record and survives teardown.
  Status reads are control-plane only, so watching the seal close never winds the clock.
- **Scale to zero:** any exhibit wakes a paused cluster; the API returns 202 while Aurora
  resumes, the page times the wake (~15s), and the measurement is filed in the wake ledger.
- **Reads:** three-table join, `permit_throughput` + `contractor_scorecard` views over a
  ~38k-row registry generated in-engine (`generate_series`) by the migration Lambda.
- **Chain of title:** a SECURITY DEFINER trigger files every superseded permit version into
  `permit_history` (who, when, why, validity window). Exhibits pull the fullest chain,
  reconstruct the record as of four different dates, and record a live amendment (column-level
  UPDATE grant + `SET LOCAL` note) that is always voided by rollback.
- **Title search:** the plank's only visitor-typed input, bound server-side as an RDS Data
  API parameter over a `pg_trgm` index on owner_name. `' OR '1'='1` passes the allowlist on
  purpose and matches nothing; EXPLAIN shows the trigram index carrying the fuzzy match.
  30/day per hashed IP on top of the global counter.
- **Concurrency:** a real lock-timeout refusal (clerk B waits 2 genuine seconds in line) and
  a real deadlock: two transactions locking each other's rows via concurrent Data API calls,
  PostgreSQL detecting the cycle and cancelling exactly one. Engine messages verbatim.
- **Row-level security:** two district desks over one `case_files` table; `SET LOCAL` desk
  assignment decides what `app_user` sees and writes, an unassigned session sees nothing, and
  a cross-district write dies on the policy's WITH CHECK.
- **Integrity:** FK violation, CHECK violation, and an atomic two-step transfer that
  rolls back, engine error messages shown verbatim; every write exhibit runs inside a
  transaction that is always rolled back.
- **Least privilege:** the API connects as `app_user` (SELECT on registry, a column-level
  UPDATE on two permit columns, writes only in the rollback sandbox); its own DELETE and
  DROP attempts dying is an exhibit.
- **Plans:** `EXPLAIN ANALYZE` index scan vs seq scan (address stays unindexed on purpose),
  live planner output.
- **Schema as code:** ordered, checksummed migrations recorded in `schema_migrations`,
  now seven books deep.

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

A forgotten teardown is bounded by the nightly **demo sweep** workflow
(`.github/workflows/demo-sweep.yml`, 09:00 UTC), which runs this same `make teardown` if the
demo root was left up.
