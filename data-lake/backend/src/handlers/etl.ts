// The lake's transform step, invoked by `make etl` after an ingest:
//   1. drop + delete the curated zone
//   2. rebuild it with one CTAS (partitioned Snappy Parquet, registered in Glue)
//   3. precompute the dashboard aggregates into the analytics zone
//   4. write a manifest of what the lake now holds
// Idempotent — run it as often as the raw zone changes.

import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { runQuery, runAndFetch } from '../lib/athena';
import {
  dropCurated, ctas, aggregates, countRows,
  dropIceberg, icebergCtas, icebergCountFixable, icebergUpdate, icebergSnapshots, cityCorrections,
} from '../lib/queries';

const s3 = new S3Client({});

const BUCKET = process.env.LAKE_BUCKET!;
const RAW_PREFIX = process.env.RAW_PREFIX!;
const CURATED_PREFIX = process.env.CURATED_PREFIX!;
const ICEBERG_PREFIX = process.env.ICEBERG_PREFIX!;
const ANALYTICS_PREFIX = process.env.ANALYTICS_PREFIX!;

const ETL_OPTS = { pollMs: 2000, deadlineMs: 840_000 };

async function listAll(prefix: string, delimiter?: string) {
  let objects = 0;
  let bytes = 0;
  const prefixes = new Set<string>();
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${prefix}/`, Delimiter: delimiter, ContinuationToken: token })
    );
    for (const o of page.Contents ?? []) {
      objects += 1;
      bytes += o.Size ?? 0;
    }
    for (const p of page.CommonPrefixes ?? []) prefixes.add(p.Prefix!);
    token = page.NextContinuationToken;
  } while (token);
  return { objects, bytes, prefixes: [...prefixes] };
}

async function clearPrefix(prefix: string) {
  let token: string | undefined;
  let deleted = 0;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${prefix}/`, ContinuationToken: token }));
    const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (keys.length > 0) {
      await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys, Quiet: true } }));
      deleted += keys.length;
    }
    token = page.NextContinuationToken;
  } while (token);
  return deleted;
}

async function putJson(key: string, body: unknown) {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: JSON.stringify(body),
      ContentType: 'application/json',
    })
  );
}

export async function handler() {
  const raw = await listAll(RAW_PREFIX);
  if (raw.objects === 0) throw new Error(`raw zone s3://${BUCKET}/${RAW_PREFIX}/ is empty — run 'make ingest' first`);

  // 1+2. drop the old curated table (DDL is free), clear its files, rebuild
  await runQuery(dropCurated, ETL_OPTS);
  const cleared = await clearPrefix(CURATED_PREFIX);
  const ctasRun = await runQuery(ctas(BUCKET, CURATED_PREFIX), ETL_OPTS);
  console.log(`ctas done: scanned ${ctasRun.stats.bytesScanned} bytes in ${ctasRun.stats.totalMs} ms (cleared ${cleared} old objects)`);

  // 3. precompute dashboard aggregates (999 = GetQueryResults' single-page
  // ceiling once the header row is counted; map_zips is the widest at ~450)
  const aggStats: Record<string, unknown> = {};
  for (const [name, sql] of Object.entries(aggregates)) {
    const res = await runAndFetch(sql, 999, ETL_OPTS);
    await putJson(`${ANALYTICS_PREFIX}/${name}.json`, { columns: res.columns, rows: res.rows });
    aggStats[name] = { rows: res.rows.length, bytesScanned: res.stats.bytesScanned };
  }

  // 3b. the time machine: rebuild the Iceberg copy, count what's fixable,
  // then correct it with ONE ACID UPDATE. CTAS commits snapshot 1 ('append'),
  // the UPDATE commits snapshot 2 ('overwrite'); the ledger goes to the
  // analytics zone so the exhibit can pin FOR VERSION AS OF queries to real
  // snapshot ids. DROP on an is_external=false table purges its data files;
  // clearPrefix is belt and braces for interrupted runs.
  await runQuery(dropIceberg, ETL_OPTS);
  await clearPrefix(ICEBERG_PREFIX);
  const iceRun = await runQuery(icebergCtas(BUCKET, ICEBERG_PREFIX), ETL_OPTS);
  const fixable = await runAndFetch(icebergCountFixable, 1, ETL_OPTS);
  const updRun = await runQuery(icebergUpdate, ETL_OPTS);
  const snaps = await runAndFetch(icebergSnapshots, 10, ETL_OPTS);
  const iceberg = {
    table: process.env.ICEBERG_TABLE ?? 'business_entities_iceberg',
    builtAt: new Date().toISOString(),
    correctedRows: Number(fixable.rows[0]?.[0] ?? 0),
    corrections: cityCorrections,
    ctasMs: iceRun.stats.totalMs,
    updateMs: updRun.stats.totalMs,
    snapshots: snaps.rows.map(([id, committedAt, operation]) => ({ id, committedAt, operation })),
  };
  await putJson(`${ANALYTICS_PREFIX}/iceberg.json`, iceberg);
  console.log(`iceberg rebuilt: ${iceberg.correctedRows} rows corrected across ${iceberg.snapshots.length} snapshots`);

  // 4. manifest — including the count(*) that scans zero bytes (Parquet
  // answers it from row-group metadata). Two lists on purpose: a delimited
  // list rolls files up into CommonPrefixes (that's the partition count),
  // so sizes need their own undelimited pass.
  const count = await runAndFetch(countRows, 1, ETL_OPTS);
  const curated = await listAll(CURATED_PREFIX);
  const partitionPrefixes = (await listAll(CURATED_PREFIX, '/')).prefixes;
  const partitions = partitionPrefixes.length;

  // Per-decade sizes feed the dashboard's partition-pruning bands: which
  // slices of the lake a query read, drawn to scale.
  const partitionDetail = (
    await Promise.all(
      partitionPrefixes.map(async (p) => {
        const m = /decade=([^/]+)\/$/.exec(p);
        const d = await listAll(p.replace(/\/$/, ''));
        return { decade: m?.[1] ?? p, bytes: d.bytes, objects: d.objects };
      })
    )
  ).sort((a, b) => a.decade.localeCompare(b.decade));

  const manifest = {
    dataset: 'Business Entities in Colorado — data.colorado.gov/resource/4ykn-tg5h (CC0, Colorado Secretary of State)',
    builtAt: new Date().toISOString(),
    totalRows: Number(count.rows[0]?.[0] ?? 0),
    countScannedBytes: count.stats.bytesScanned,
    raw: { objects: raw.objects, bytes: raw.bytes, format: 'JSONL + gzip' },
    curated: {
      objects: curated.objects,
      bytes: curated.bytes,
      partitions,
      partitionDetail,
      format: 'Parquet + Snappy, partitioned by decade',
    },
    ctas: { ms: ctasRun.stats.totalMs, bytesScanned: ctasRun.stats.bytesScanned },
    iceberg: { snapshots: iceberg.snapshots.length, correctedRows: iceberg.correctedRows },
    aggregates: aggStats,
  };
  await putJson(`${ANALYTICS_PREFIX}/manifest.json`, manifest);

  console.log(JSON.stringify(manifest));
  return manifest;
}
