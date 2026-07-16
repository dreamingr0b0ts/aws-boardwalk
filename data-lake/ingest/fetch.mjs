// Ingest: pull the full "Business Entities in Colorado" dataset (CC0, Colorado
// Secretary of State via data.colorado.gov) into the lake's raw zone as
// gzipped JSONL — records exactly as the source API returns them, one page
// per object. Run via `make ingest`; re-running replaces the snapshot.
//
// Keyset pagination on entityid (not $offset — deep offsets crawl and can
// skip/dup rows if the dataset updates mid-ingest). ~3.1M rows ≈ 62 pages.

import { gzipSync } from 'node:zlib';
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

const BUCKET = process.env.LAKE_BUCKET;
const RAW_PREFIX = process.env.RAW_PREFIX ?? 'raw/business_entities';
if (!BUCKET) {
  console.error('LAKE_BUCKET env var required (see Makefile "ingest" target)');
  process.exit(1);
}

const DATASET = 'https://data.colorado.gov/resource/4ykn-tg5h.json';
const FIELDS = [
  'entityid',
  'entityname',
  'principalcity',
  'principalstate',
  'principalzipcode',
  'entitystatus',
  'entitytype',
  'jurisdictonofformation', // (sic) — preserved as delivered; the ETL renames it
  'agentorganizationname',
  'entityformdate',
];
const PAGE = 50_000;

const s3 = new S3Client({});
const headers = process.env.SOCRATA_APP_TOKEN ? { 'X-App-Token': process.env.SOCRATA_APP_TOKEN } : {};

async function fetchPage(afterId) {
  const params = new URLSearchParams({
    $select: FIELDS.join(','),
    $order: 'entityid',
    $limit: String(PAGE),
  });
  if (afterId !== null) params.set('$where', `entityid > ${afterId}`);
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${DATASET}?${params}`, { headers });
    if (res.ok) return res.json();
    if (attempt >= 5) throw new Error(`socrata ${res.status} after ${attempt} attempts`);
    console.log(`  socrata ${res.status}, retrying in ${attempt * 5}s…`);
    await new Promise((r) => setTimeout(r, attempt * 5000));
  }
}

async function clearRawZone() {
  let token;
  let deleted = 0;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${RAW_PREFIX}/`, ContinuationToken: token }));
    const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key }));
    if (keys.length > 0) {
      await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys, Quiet: true } }));
      deleted += keys.length;
    }
    token = page.NextContinuationToken;
  } while (token);
  if (deleted > 0) console.log(`cleared ${deleted} objects from the previous snapshot`);
}

await clearRawZone();

let afterId = null;
let part = 0;
let rows = 0;
let bytes = 0;
const t0 = Date.now();

for (;;) {
  const records = await fetchPage(afterId);
  if (records.length === 0) break;

  const body = gzipSync(records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const key = `${RAW_PREFIX}/part-${String(part).padStart(4, '0')}.jsonl.gz`;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: 'application/gzip' }));

  rows += records.length;
  bytes += body.length;
  part += 1;
  afterId = records[records.length - 1].entityid;
  console.log(`  part ${part}: +${records.length} rows (total ${rows.toLocaleString()}, ${(bytes / 1e6).toFixed(1)} MB gz)`);

  if (records.length < PAGE) break;
}

console.log(
  `ingested ${rows.toLocaleString()} rows in ${part} objects, ${(bytes / 1e6).toFixed(1)} MB gzipped, ${Math.round((Date.now() - t0) / 1000)}s → s3://${BUCKET}/${RAW_PREFIX}/`
);
