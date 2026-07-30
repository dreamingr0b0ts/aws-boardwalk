# Plank 5 — Data Lake & Analytics

**Live:** https://data.demos.planetek.org

A serverless S3 data lake over **real public open data**: every business entity ever
registered with the Colorado Secretary of State — ~3.1M rows back to 1864, via
[data.colorado.gov (4ykn-tg5h)](https://data.colorado.gov/Business/Business-Entities-in-Colorado/4ykn-tg5h), CC0.

```
data.colorado.gov ── ingest (local, make ingest) ──► S3 raw/  (JSONL + gzip, as delivered)
                                                        │
                                    Glue Data Catalog ◄─┤ raw table = Terraform (schema contract)
                                                        ▼
                              dla-etl Lambda: one Athena CTAS ──► S3 curated/  (Parquet + Snappy,
                                    + precomputed aggregates          partitioned by decade)
                                                        │                 │
                                                        │                 ▼ CTAS + one ACID UPDATE
                                                        │             S3 iceberg/ (Apache Iceberg,
                                                        │                 two snapshots, time travel)
                                                        ▼ S3 analytics/ (dashboard JSON + snapshot ledger)
CloudFront (data.demos…) ──► static dashboard ──► /api/* ──► dla-api Lambda
                                                              ├─ GET  /api/summary  (analytics zone, $0)
                                                              ├─ GET  /api/queries  (canned catalog)
                                                              ├─ POST /api/query    (live Athena, capped)
                                                              └─ POST /api/search   (parameterized name lookup)
```

## What it proves

- **Lake zoning:** raw (immutable, as-delivered JSONL.gz) vs curated (typed, cleaned,
  columnar) vs analytics (precomputed serving layer). The source column typo
  (`jurisdictonofformation`) is preserved in raw and fixed in curated — real cleansing.
- **SQL-on-S3 economics:** the dashboard's "raw vs curated race" runs the identical
  aggregation over both zones and shows Athena's own bytes-scanned/cost numbers;
  partitioned queries show pruning; `count(*)` over Parquet scans zero bytes.
- **Cost governance:** an enforced Athena workgroup (locked result location, per-query
  scan cutoff), a DynamoDB result cache, and a global daily execution budget.
- **BI without per-seat fees:** the dashboard is a static page rendering ETL-precomputed
  JSON — no QuickSight, $0 per viewer.
- **Safe visitor input ("find your boat"):** the name lookup binds visitor text to a `?`
  via Athena **execution parameters** — it never enters the SQL string. The engine parses
  each parameter as one expression in the placeholder position (an injection-shaped value
  fails with TYPE_MISMATCH rather than widening the WHERE), and the API allowlists the
  charset and quotes/escapes the literal anyway. Per-IP daily counter on top of the
  global budget.
- **The engine under glass:** every live run returns `GetQueryRuntimeStatistics` — the
  distributed stage tree (rows/bytes in and out per stage) plus the queue/plan/execute
  timeline — and the dashboard draws which decade partitions were eligible vs skipped,
  to scale, from per-partition sizes the ETL records in the manifest.
- **The depth chart:** a bathymetric map of ZIP-level density (Good Standing entities at
  Census ZCTA centroids over county lines), precomputed by the ETL, drawn from vendored
  public-domain Census geometry (`scripts/build-geo.mjs` refreshes it).
- **The time machine (Apache Iceberg):** the ETL copies the curated table into an Iceberg
  table (CTAS, snapshot 1), then repairs ~5.4k rows of real city-name misspellings with ONE
  ACID `UPDATE` (snapshot 2) — an enumerated variant list, not a fuzzy match. The exhibit
  runs the identical aggregation `FOR VERSION AS OF` each snapshot: 23 spellings collapse to
  3 and the totals reconcile exactly. Snapshot ids come from the ETL's ledger in the
  analytics zone, never from the visitor.

## Cost

Idle ≈ $0 (S3 storage pennies; no servers). Athena bills $5/TB scanned with a 10 MB
minimum: visitors can run the canned catalog and the name lookup (never arbitrary SQL —
lookup input is an execution parameter, not spliced text), results cache for 6 h, and
live executions are capped at **150/day globally** with a **600 MB per-query cutoff** —
worst sustained abuse ≈ $0.45/day, unchanged by the lookup (searches take a slot from
the same global budget, plus a **30/day per-IP** counter). No credential gate needed
(cf. planks 6/7).

## Operate

| Command | What it does |
|---|---|
| `make deploy` | build lambdas, apply Terraform, publish frontend |
| `make seed` | `ingest` (source → raw zone, ~5 min) + `etl` (CTAS rebuild + aggregates) |
| `make etl` | rebuild curated zone + analytics from the current raw snapshot |
| `make verify` | 46-check end-to-end suite against the live site |
| `make destroy` | tear down (lake bucket force-destroys) |

The snapshot is deliberately static between refreshes (`make seed` re-pulls the source);
the manifest on the site shows the snapshot date. There is no nightly job — nothing a
visitor does can write to the lake.

## Design

Plank identity: the lake survey. A data lake charted like a body of water:
bathymetric-chart blues, survey-paper light mode, "the deep" after dark, one
buoy-orange accent reserved for actions and emphasis. Depth-contour lines in the
hero, a shallow-to-deep depth-tint scale as the section marker, and
[Bricolage Grotesque](https://github.com/ateliertriay/bricolage) (OFL) for display
type, vendored as static woff2 in `frontend/fonts/` (the CSP allows only
self-hosted assets). Chart mark colors (#0b74ad/#c74e1e light, #2e9bc4/#e8632e
dark) are validated for lightness band, chroma floor, CVD separation, and
surface contrast in both color schemes.

Hero photo: near-abstract deep navy ripples by
[Liana S](https://unsplash.com/photos/7C6Xnao43LY) (Unsplash license), resized
via CDN params and self-hosted in `frontend/images/`.

## Gotchas encoded here

- **Athena CTAS caps at 100 partitions per query** — partitioning is by `decade`
  (~18 partitions), not year (~160 would fail).
- **An enforced workgroup rejects CTAS `external_location`** — hence two workgroups:
  visitors query the enforced `dla-public`; the ETL rebuilds through the non-enforced
  `dla-etl`, which only the etl role's IAM can reach.
- The curated table is **deliberately not in Terraform**: CTAS creates/registers it, the
  ETL drops and rebuilds it. Terraform owns the raw table (a schema contract with ingest).
- Athena runs S3/Glue calls with the **caller's** IAM credentials — the api role can read
  the lake but only the etl role can write the curated zone or touch its catalog entry.
- Socrata ingest uses **keyset pagination on `entityid`** (`$where=entityid > last`), not
  `$offset` — deep offsets crawl and can skip/duplicate rows mid-update.
- Athena parses each **execution parameter as one expression in the `?` position** — an
  injection-shaped value (`'x' OR '1'='1'`) fails with TYPE_MISMATCH instead of widening
  the WHERE. Verified live before shipping the lookup.
- **`DROP TABLE` on an `is_external=false` Iceberg table purges its S3 data files** — the
  ETL's clearPrefix after the drop is only insurance against interrupted runs.
- Iceberg time travel (`FOR VERSION AS OF`) runs fine in an **enforced workgroup** — only
  CTAS `external_location` is rejected there, so visitors can read snapshots through
  `dla-public` while the ETL writes through `dla-etl`.
