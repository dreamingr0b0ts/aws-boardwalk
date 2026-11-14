// Behavioral tests for the upload cost gate, with the AWS clients replaced by
// an in-memory fake: one counted grant must equal at most one Textract job,
// whatever is replayed, swapped, or retried. Run with `npm test`.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { PDFDocument } from 'pdf-lib';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { TextractClient } from '@aws-sdk/client-textract';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'build'); // gitignored (build/)

Object.assign(process.env, {
  TABLE_NAME: 'docs',
  DOCS_BUCKET: 'bucket',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'AKIAFAKEFAKEFAKEFAKE',
  AWS_SECRET_ACCESS_KEY: 'fake',
  ORIGIN_VERIFY: 'only-cloudfront-knows-this',
});

// ---- the fake cloud ---------------------------------------------------------
const objects = new Map(); // key -> { body, contentType, metadata }
const items = new Map(); // "PK|SK" -> item
const jobs = []; // StartDocumentAnalysis inputs
const tokens = new Map(); // ClientRequestToken -> JobId

const itemKey = (k) => `${k.PK}|${k.SK}`;

DynamoDBDocumentClient.prototype.send = async (cmd) => {
  const { input } = cmd;
  switch (cmd.constructor.name) {
    case 'PutCommand':
      items.set(itemKey(input.Item), { ...input.Item });
      return {};
    case 'GetCommand':
      return { Item: items.get(itemKey(input.Key)) };
    case 'UpdateCommand': {
      const v = input.ExpressionAttributeValues ?? {};
      const existing = items.get(itemKey(input.Key));
      if (input.ConditionExpression?.includes('#k = :key')) {
        // claimGrant: the grant must exist for this key and be unclaimed (or ours)
        const free = existing && existing.s3Key === v[':key'] && (!existing.claimedBy || existing.claimedBy === v[':run']);
        if (!free) throw new ConditionalCheckFailedException({ message: 'conditional check failed', $metadata: {} });
        existing.claimedBy = v[':run'];
        return {};
      }
      if (input.ConditionExpression) {
        // usage counters: attribute_not_exists(#n) OR #n < :limit
        const n = existing?.count ?? 0;
        if (n >= v[':limit']) throw new ConditionalCheckFailedException({ message: 'limit', $metadata: {} });
        items.set(itemKey(input.Key), { ...input.Key, count: n + 1 });
        return { Attributes: { count: n + 1 } };
      }
      const item = existing ?? { ...input.Key };
      if (v[':key']) Object.assign(item, { s3Key: v[':key'], ttl: v[':ttl'] }); // putGrant
      else item.updates = (item.updates ?? 0) + 1; // updateDoc
      items.set(itemKey(input.Key), item);
      return {};
    }
    default:
      throw new Error(`unexpected DynamoDB call ${cmd.constructor.name}`);
  }
};

S3Client.prototype.send = async (cmd) => {
  const { input } = cmd;
  const o = objects.get(input.Key);
  switch (cmd.constructor.name) {
    case 'HeadObjectCommand':
      return { ContentLength: o.body.byteLength, ContentType: o.contentType, Metadata: o.metadata };
    case 'GetObjectCommand':
      return { Body: { transformToByteArray: async () => o.body } };
    case 'PutObjectCommand':
      objects.set(input.Key, { body: input.Body, contentType: input.ContentType, metadata: input.Metadata });
      return {};
    default:
      throw new Error(`unexpected S3 call ${cmd.constructor.name}`);
  }
};

TextractClient.prototype.send = async (cmd) => {
  assert.equal(cmd.constructor.name, 'StartDocumentAnalysisCommand');
  const token = cmd.input.ClientRequestToken;
  if (!tokens.has(token)) {
    tokens.set(token, `job-${tokens.size + 1}`);
    jobs.push(cmd.input); // only a new token is a new (billed) job
  }
  return { JobId: tokens.get(token) };
};

// ---- fixtures ---------------------------------------------------------------
async function pdf(pages) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  return doc.save();
}

function tiff(pages) {
  const IFD = 2 + 12 + 4;
  const buf = new Uint8Array(8 + pages * IFD);
  const dv = new DataView(buf.buffer);
  buf.set([0x49, 0x49, 0x2a, 0x00]);
  dv.setUint32(4, 8, true);
  for (let p = 0; p < pages; p++) {
    const at = 8 + p * IFD;
    dv.setUint16(at, 1, true);
    dv.setUint16(at + 2, 256, true);
    dv.setUint32(at + 2 + 12, p + 1 < pages ? at + IFD : 0, true);
  }
  return buf;
}

const upload = (key, body, contentType = 'application/pdf', source = 'anon') =>
  objects.set(key, { body, contentType, metadata: { source, uploader: 'visitor:abc' } });

const grant = (docId, key) => items.set(`DOC#${docId}|GRANT`, { PK: `DOC#${docId}`, SK: 'GRANT', s3Key: key });
const record = (docId) => items.get(`DOC#${docId}|META`);
const run = (ocr, key, executionId) => ocr.handler({ step: 'start', bucket: 'bucket', key, executionId });

let ocr;
let api;

before(async () => {
  await build({
    entryPoints: ['src/handlers/ocr.ts', 'src/handlers/api.ts'],
    outdir: out,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    packages: 'external', // share the SDK classes patched above
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });
  ocr = await import(pathToFileURL(join(out, 'ocr.mjs')).href);
  api = await import(pathToFileURL(join(out, 'api.mjs')).href);
});

after(() => rmSync(out, { recursive: true, force: true }));

beforeEach(() => {
  objects.clear();
  items.clear();
  jobs.length = 0;
  tokens.clear();
});

// ---- the gate ---------------------------------------------------------------
test('a granted upload starts exactly one job, on the pinned copy', async () => {
  const key = 'incoming/anon-1/doc.pdf';
  const body = await pdf(2);
  upload(key, body);
  grant('anon-1', key);

  const res = await run(ocr, key, 'exec-A');
  assert.equal(res.rejected, false);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].DocumentLocation.S3Object.Name, 'validated/anon-1/doc.pdf');
  assert.deepEqual(objects.get('validated/anon-1/doc.pdf').body, body);
  assert.equal(record('anon-1').s3Key, 'validated/anon-1/doc.pdf');
  assert.equal(record('anon-1').status, 'PROCESSING');
  assert.equal(record('anon-1').source, 'anon');
});

test('replaying the same presigned POST never starts another job', async () => {
  const key = 'incoming/anon-2/doc.pdf';
  upload(key, await pdf(2));
  grant('anon-2', key);
  await run(ocr, key, 'exec-A');
  const first = structuredClone(record('anon-2'));

  for (let i = 0; i < 25; i++) {
    upload(key, await pdf(1)); // each re-POST overwrites the object and fires a new event
    assert.deepEqual(await run(ocr, key, `exec-replay-${i}`), { docId: 'anon-2', rejected: true });
  }
  assert.equal(jobs.length, 1, 'one grant, one Textract job');
  assert.deepEqual(record('anon-2'), first, 'replays leave the first run\'s record alone');
});

test('an object with no grant is ignored without a record or a job', async () => {
  const key = 'incoming/anon-3/doc.pdf';
  upload(key, await pdf(1));
  assert.deepEqual(await run(ocr, key, 'exec-A'), { docId: 'anon-3', rejected: true });
  assert.equal(jobs.length, 0);
  assert.equal(record('anon-3'), undefined);
});

test('a grant for one key cannot be spent on another', async () => {
  upload('incoming/anon-4/other.pdf', await pdf(1));
  grant('anon-4', 'incoming/anon-4/doc.pdf');
  assert.equal((await run(ocr, 'incoming/anon-4/other.pdf', 'exec-A')).rejected, true);
  assert.equal(jobs.length, 0);
});

test('a retry of the same execution continues and reuses the job', async () => {
  const key = 'incoming/anon-5/doc.pdf';
  upload(key, await pdf(1));
  grant('anon-5', key);
  const a = await run(ocr, key, 'exec-A');
  const b = await run(ocr, key, 'exec-A');
  assert.equal(b.rejected, false);
  assert.equal(a.jobId, b.jobId);
  assert.equal(jobs.length, 1);
});

test('swapping the object after validation cannot change what Textract reads', async () => {
  const key = 'incoming/anon-6/doc.pdf';
  const small = await pdf(1);
  upload(key, small);
  grant('anon-6', key);
  await run(ocr, key, 'exec-A');
  upload(key, await pdf(500)); // the uploader overwrites incoming/ while the job is queued
  assert.deepEqual(objects.get(jobs[0].DocumentLocation.S3Object.Name).body, small);
});

test('a multi-page TIFF over the cap is rejected before any job', async () => {
  const key = 'incoming/anon-7/scan.tiff';
  upload(key, tiff(3000), 'image/tiff');
  grant('anon-7', key);
  assert.equal((await run(ocr, key, 'exec-A')).rejected, true);
  assert.equal(jobs.length, 0);
  assert.equal(record('anon-7').status, 'REJECTED');
  assert.match(record('anon-7').rejectReason, /more than 6 pages/);
  assert.equal(objects.has('validated/anon-7/scan.tiff'), false);
});

test('a PDF dressed as a PNG is rejected before any job', async () => {
  const key = 'incoming/anon-8/photo.png';
  upload(key, await pdf(500), 'image/png');
  grant('anon-8', key);
  assert.equal((await run(ocr, key, 'exec-A')).rejected, true);
  assert.equal(jobs.length, 0);
  assert.match(record('anon-8').rejectReason, /does not match/);
});

test('seed uploads need no grant and can be re-seeded', async () => {
  const key = 'incoming/seed-invoice/invoice.pdf';
  upload(key, await pdf(2), 'application/pdf', 'seed');
  assert.equal((await run(ocr, key, 'exec-A')).rejected, false);
  assert.equal((await run(ocr, key, 'exec-B')).rejected, false);
  assert.equal(jobs.length, 2);
  assert.equal(record('seed-invoice').source, 'seed');
});

test('issuing an upload writes the grant for exactly the presigned key', async () => {
  const res = await api.handler({
    routeKey: 'POST /api/public/uploads',
    headers: { 'x-forwarded-for': '203.0.113.7, 198.51.100.1', 'x-origin-verify': process.env.ORIGIN_VERIFY },
    requestContext: { http: { sourceIp: '198.51.100.1' } },
    body: JSON.stringify({ filename: 'my scan.pdf', contentType: 'application/pdf', sizeBytes: 1000 }),
  });
  assert.equal(res.statusCode, 200);
  const { docId, upload: post } = JSON.parse(res.body);
  assert.match(docId, /^anon-\d{8}-[0-9a-f-]{36}$/);
  assert.equal(post.fields.key, `incoming/${docId}/my-scan.pdf`);
  const g = items.get(`DOC#${docId}|GRANT`);
  assert.equal(g.s3Key, post.fields.key);
  assert.equal(g.claimedBy, undefined);

  const policy = JSON.parse(Buffer.from(post.fields.Policy, 'base64').toString());
  const life = (Date.parse(policy.expiration) - Date.now()) / 1000;
  assert.ok(life > 60 && life <= 121, `POST lives ${life}s`);

  // ...and that grant is what lets the pipeline run once.
  objects.set(post.fields.key, { body: await pdf(1), contentType: 'application/pdf', metadata: { source: 'anon' } });
  assert.equal((await run(ocr, post.fields.key, 'exec-A')).rejected, false);
  assert.equal((await run(ocr, post.fields.key, 'exec-B')).rejected, true);
  assert.equal(jobs.length, 1);
});

test('a request that did not come through CloudFront is refused before anything is written', async () => {
  const direct = (headers) =>
    api.handler({
      routeKey: 'POST /api/public/uploads',
      // On the direct path the caller writes this whole chain, which is why
      // the visitor caps cannot be trusted there.
      headers: { 'x-forwarded-for': '192.0.2.1, 192.0.2.2', ...headers },
      requestContext: { http: { sourceIp: '192.0.2.2' } },
      body: JSON.stringify({ filename: 'scan.pdf', contentType: 'application/pdf', sizeBytes: 1000 }),
    });
  const secret = process.env.ORIGIN_VERIFY;
  for (const headers of [{}, { 'x-origin-verify': '' }, { 'x-origin-verify': 'guess' }, { 'x-origin-verify': 'x'.repeat(secret.length) }]) {
    assert.equal((await direct(headers)).statusCode, 403, JSON.stringify(headers));
  }
  assert.equal(items.size, 0, 'no grant, no counter');

  // Fails closed: a function deployed without the secret trusts nothing,
  // not even an empty header that "matches" the empty configuration.
  delete process.env.ORIGIN_VERIFY;
  try {
    assert.equal((await direct({})).statusCode, 403);
    assert.equal((await direct({ 'x-origin-verify': '' })).statusCode, 403);
  } finally {
    process.env.ORIGIN_VERIFY = secret;
  }
});
