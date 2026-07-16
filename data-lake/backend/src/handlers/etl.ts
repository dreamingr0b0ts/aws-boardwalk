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
import { dropCurated, ctas, aggregates, countRows } from '../lib/queries';

const s3 = new S3Client({});

const BUCKET = process.env.LAKE_BUCKET!;
const RAW_PREFIX = process.env.RAW_PREFIX!;
const CURATED_PREFIX = process.env.CURATED_PREFIX!;
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

  // 3. precompute dashboard aggregates
  const aggStats: Record<string, unknown> = {};
  for (const [name, sql] of Object.entries(aggregates)) {
    const res = await runAndFetch(sql, 200, ETL_OPTS);
    await putJson(`${ANALYTICS_PREFIX}/${name}.json`, { columns: res.columns, rows: res.rows });
    aggStats[name] = { rows: res.rows.length, bytesScanned: res.stats.bytesScanned };
  }

  // 4. manifest — including the count(*) that scans zero bytes (Parquet
  // answers it from row-group metadata). Two lists on purpose: a delimited
  // list rolls files up into CommonPrefixes (that's the partition count),
  // so sizes need their own undelimited pass.
  const count = await runAndFetch(countRows, 1, ETL_OPTS);
  const curated = await listAll(CURATED_PREFIX);
  const partitions = (await listAll(CURATED_PREFIX, '/')).prefixes.length;

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
      format: 'Parquet + Snappy, partitioned by decade',
    },
    ctas: { ms: ctasRun.stats.totalMs, bytesScanned: ctasRun.stats.bytesScanned },
    aggregates: aggStats,
  };
  await putJson(`${ANALYTICS_PREFIX}/manifest.json`, manifest);

  console.log(JSON.stringify(manifest));
  return manifest;
}
