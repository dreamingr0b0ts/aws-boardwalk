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
                                                        │
                                                        ▼ S3 analytics/ (dashboard JSON)
CloudFront (data.demos…) ──► static dashboard ──► /api/* ──► dla-api Lambda
                                                              ├─ GET  /api/summary  (analytics zone, $0)
                                                              ├─ GET  /api/queries  (canned catalog)
                                                              └─ POST /api/query    (live Athena, capped)
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

## Cost

Idle ≈ $0 (S3 storage pennies; no servers). Athena bills $5/TB scanned with a 10 MB
minimum: visitors can only run the canned catalog (no arbitrary SQL), results cache for
6 h, and live executions are capped at **150/day globally** with a **600 MB per-query
cutoff** — worst sustained abuse ≈ $0.45/day. No credential gate needed (cf. planks 6/7).

## Operate

| Command | What it does |
|---|---|
| `make deploy` | build lambdas, apply Terraform, publish frontend |
| `make seed` | `ingest` (source → raw zone, ~5 min) + `etl` (CTAS rebuild + aggregates) |
| `make etl` | rebuild curated zone + analytics from the current raw snapshot |
| `make verify` | 24-check end-to-end suite against the live site |
| `make destroy` | tear down (lake bucket force-destroys) |

The snapshot is deliberately static between refreshes (`make seed` re-pulls the source);
the manifest on the site shows the snapshot date. There is no nightly job — nothing a
visitor does can write to the lake.

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
