import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, randomUUID } from 'node:crypto';
import { spanBoxes, type WordRef } from '../lib/geometry.js';
import { claims, HttpError, json, parseBody, requireString, router, type ApiEvent } from '../lib/http.js';
import { ddb, TABLE, type Box, type DocRecord } from '../lib/store.js';

const BUCKET = process.env.DOCS_BUCKET!;
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 4 * 1024 * 1024);
const USER_DAILY_LIMIT = Number(process.env.USER_DAILY_LIMIT ?? 8);
const GLOBAL_DAILY_LIMIT = Number(process.env.GLOBAL_DAILY_LIMIT ?? 30);
const ANON_DAILY_LIMIT = Number(process.env.ANON_DAILY_LIMIT ?? 5);
const ANON_GLOBAL_DAILY_LIMIT = Number(process.env.ANON_GLOBAL_DAILY_LIMIT ?? 10);

const CONTENT_TYPES: Record<string, string[]> = {
  'application/pdf': ['pdf'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/tiff': ['tif', 'tiff'],
};

const s3 = new S3Client({});

// ---- public routes (free: DynamoDB reads only, no AI services) ----

const LIST_FIELDS = [
  'docId', 'status', 'filename', 'title', 'docType', 'docTypeConfidence', 'summary', 'pages',
  'ocrConfidence', 'hasPii', 'source', 'createdAt', 'entityCount', 'docDate', 'sizeBytes', 'rejectReason',
  'cost', 'needsReview', 'reviewFields',
] as const;

async function scanDocs(): Promise<DocRecord[]> {
  const docs: DocRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: TABLE,
        FilterExpression: 'SK = :meta',
        ExpressionAttributeValues: { ':meta': 'META' },
        ExclusiveStartKey: startKey,
      })
    );
    docs.push(...((page.Items ?? []) as DocRecord[]));
    startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  // Anonymous uploads are private to their uploader: reachable only through
  // the unguessable docId the uploader was handed, never listed or counted.
  return docs
    .filter((d) => d.source !== 'anon')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 200);
}

async function listDocuments() {
  const docs = await scanDocs();
  const indexed = docs.filter((d) => d.status === 'INDEXED');

  const stats = {
    documents: indexed.length,
    pages: indexed.reduce((n, d) => n + (d.pages ?? 0), 0),
    entities: indexed.reduce((n, d) => n + (d.entityCount ?? 0), 0),
    docTypes: new Set(indexed.map((d) => d.docType).filter(Boolean)).size,
  };

  const documents = docs.map((d) => Object.fromEntries(LIST_FIELDS.map((f) => [f, d[f]]).filter(([, v]) => v !== undefined)));
  return json(200, { stats, documents });
}

async function getDocument(event: ApiEvent) {
  const docId = requireString(event.pathParameters?.id, 'id', 1, 80);
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `DOC#${docId}`, SK: 'META' } }));
  const doc = res.Item as DocRecord | undefined;
  if (!doc) throw new HttpError(404, 'Document not found');

  // Short-lived link to the original file so the UI can show the source
  // side-by-side with what the pipeline extracted from it.
  const originalUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: doc.s3Key }), {
    expiresIn: 300,
  });

  const { uploadedBy: _private, ...publicDoc } = doc;
  return json(200, { ...publicDoc, PK: undefined, SK: undefined, originalUrl });
}

// ---- archive search: every word of every public document -------------------
//
// Free like the other public reads: DynamoDB + S3 GETs only. The extraction
// JSONs (text + word map) are memoized per container against the record's
// textChars fingerprint, so a warm search over the whole corpus is a scan
// plus zero-to-few S3 reads.

const SEARCH_MAX_DOCS = 60;
const SEARCH_MAX_RESULTS = 12;
const SEARCH_SNIPPETS_PER_DOC = 2;
const SEARCH_BOXES_PER_DOC = 12;

interface CachedExtraction {
  fingerprint: number;
  text: string;
  lower: string;
  words: WordRef[];
}
const extractionCache = new Map<string, CachedExtraction>();

async function loadExtraction(doc: DocRecord): Promise<CachedExtraction | null> {
  const fingerprint = doc.textChars ?? -1;
  const hit = extractionCache.get(doc.docId);
  if (hit && hit.fingerprint === fingerprint) return hit;
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `extracted/${doc.docId}.json` }));
    const ex = JSON.parse(await obj.Body!.transformToString()) as { text: string; words?: WordRef[] };
    const entry: CachedExtraction = { fingerprint, text: ex.text, lower: ex.text.toLowerCase(), words: ex.words ?? [] };
    extractionCache.set(doc.docId, entry);
    return entry;
  } catch {
    return null; // extraction may be mid-write or purged; skip the document
  }
}

function snippetAround(text: string, at: number, len: number): string {
  const from = Math.max(0, at - 55);
  const to = Math.min(text.length, at + len + 55);
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replaceAll('\n', ' ')}${to < text.length ? '…' : ''}`;
}

async function searchArchive(event: ApiEvent) {
  const q = requireString(event.queryStringParameters?.q, 'q', 2, 60).toLowerCase();

  const docs = (await scanDocs())
    .filter((d) => d.status === 'INDEXED' && d.extractKey)
    .slice(0, SEARCH_MAX_DOCS);

  const results = (
    await Promise.all(
      docs.map(async (doc) => {
        const ex = await loadExtraction(doc);
        if (!ex) return null;

        const hits: number[] = [];
        for (let i = ex.lower.indexOf(q); i !== -1 && hits.length < 40; i = ex.lower.indexOf(q, i + q.length)) {
          hits.push(i);
        }
        if (!hits.length) return null;

        const boxes: Box[] = [];
        for (const at of hits) {
          if (boxes.length >= SEARCH_BOXES_PER_DOC) break;
          boxes.push(...spanBoxes(ex.words, at, at + q.length));
        }
        const snippets = hits.slice(0, SEARCH_SNIPPETS_PER_DOC).map((at) => ({
          text: snippetAround(ex.text, at, q.length),
          page: ex.words.find((w) => w.start < at + q.length && w.end > at)?.box.p ?? 1,
        }));

        return {
          docId: doc.docId,
          title: doc.title ?? doc.filename,
          docType: doc.docType,
          pages: doc.pages,
          count: hits.length,
          snippets,
          boxes: boxes.slice(0, SEARCH_BOXES_PER_DOC),
        };
      })
    )
  )
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .sort((a, b) => b.count - a.count)
    .slice(0, SEARCH_MAX_RESULTS);

  return json(200, { query: q, results, searched: docs.length });
}

// ---- upload grants (each accepted upload spends Textract/AI money) ----

// Visitor identity: the viewer IP reduced to a truncated hash, so counters
// and metadata count visitors without storing addresses. CloudFront appends
// the true viewer IP and API Gateway appends CloudFront's, so the second-
// from-last X-Forwarded-For entry cannot be spoofed by a client-sent header.
// (Same fence as planks 6 and 12.)
function visitor(event: ApiEvent): { sub: string; email: string } {
  const xff = (event.headers?.['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const ip = xff.length >= 2 ? xff[xff.length - 2] : (xff[0] ?? event.requestContext.http.sourceIp ?? 'unknown');
  const sub = createHash('sha256').update(ip).digest('hex').slice(0, 16);
  return { sub, email: `visitor:${sub.slice(0, 8)}` };
}

async function bumpCounter(date: string, sk: string, limit: number): Promise<number> {
  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `USAGE#${date}`, SK: sk },
      UpdateExpression: 'ADD #n :one SET #ttl = if_not_exists(#ttl, :ttl)',
      ConditionExpression: 'attribute_not_exists(#n) OR #n < :limit',
      ExpressionAttributeNames: { '#n': 'count', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':one': 1,
        ':limit': limit,
        ':ttl': Math.floor(Date.now() / 1000) + 2 * 86400,
      },
      ReturnValues: 'UPDATED_NEW',
    })
  );
  return Number(res.Attributes?.count ?? 0);
}

async function readCounter(date: string, sk: string): Promise<number> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `USAGE#${date}`, SK: sk } }));
  return Number(res.Item?.count ?? 0);
}

async function bumpOr429(date: string, sk: string, limit: number, message: string): Promise<number> {
  try {
    return await bumpCounter(date, sk, limit);
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) throw new HttpError(429, message);
    throw err;
  }
}

interface UploadRequest {
  filename: string;
  contentType: string;
  sizeBytes: number;
}

/**
 * The cost gate, in order: identity (Cognito JWT at the gateway, or the
 * hashed viewer IP for the anonymous taste tier) → request validation → the
 * tier's daily caps → global daily kill switch → only then a presigned POST
 * whose conditions re-pin key, content type, and size at the S3 door.
 * Anonymous uploads share the same global cap, so opening the taste tier
 * moved the worst-case day's page count not one page.
 */
async function issueUpload(event: ApiEvent, anon: boolean) {
  const who = anon ? visitor(event) : claims(event);
  const body = parseBody<UploadRequest>(event);
  const filename = requireString(body.filename, 'filename', 1, 120);

  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const allowedExts = CONTENT_TYPES[body.contentType];
  if (!allowedExts) throw new HttpError(400, 'Only PDF, PNG, JPEG, and TIFF files are supported');
  if (!allowedExts.includes(ext)) throw new HttpError(400, `File extension .${ext} does not match type ${body.contentType}`);
  if (!Number.isInteger(body.sizeBytes) || body.sizeBytes < 1 || body.sizeBytes > MAX_UPLOAD_BYTES) {
    throw new HttpError(400, `File must be 1 byte – ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  }

  const today = new Date().toISOString().slice(0, 10);
  let tierUsed: number;
  let poolUsed = 0;
  if (anon) {
    tierUsed = await bumpOr429(today, `ANON#${who.sub}`, ANON_DAILY_LIMIT,
      `Daily anonymous limit reached (${ANON_DAILY_LIMIT} documents). Resets at 00:00 UTC, or sign in with demo credentials.`);
    poolUsed = await bumpOr429(today, 'ANON-GLOBAL', ANON_GLOBAL_DAILY_LIMIT,
      'The anonymous pool is exhausted for today. Try again after 00:00 UTC, or sign in with demo credentials.');
  } else {
    tierUsed = await bumpOr429(today, `USER#${who.sub}`, USER_DAILY_LIMIT,
      `Daily demo limit reached (${USER_DAILY_LIMIT} documents). Resets at 00:00 UTC.`);
  }
  const globalUsed = await bumpOr429(today, 'GLOBAL', GLOBAL_DAILY_LIMIT,
    'The demo has reached its global daily budget. Try again after 00:00 UTC.');

  // Anonymous docIds are full UUIDs on purpose: the id is the only key to a
  // private document, so it has to be unguessable.
  const docId = anon
    ? `anon-${today.replaceAll('-', '')}-${randomUUID()}`
    : `${today.replaceAll('-', '')}-${randomUUID().slice(0, 8)}`;
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '-');

  const post = await createPresignedPost(s3, {
    Bucket: BUCKET,
    Key: `incoming/${docId}/${safeName}`,
    Conditions: [
      ['content-length-range', 1, MAX_UPLOAD_BYTES],
      { 'Content-Type': body.contentType },
    ],
    Fields: {
      'Content-Type': body.contentType,
      'x-amz-meta-source': anon ? 'anon' : 'upload',
      'x-amz-meta-uploader': who.email,
    },
    Expires: 300,
  });

  return json(200, {
    docId,
    upload: { url: post.url, fields: post.fields },
    quota: anon
      ? { anonUsed: tierUsed, anonLimit: ANON_DAILY_LIMIT, poolUsed, poolLimit: ANON_GLOBAL_DAILY_LIMIT }
      : { userUsed: tierUsed, userLimit: USER_DAILY_LIMIT, globalUsed, globalLimit: GLOBAL_DAILY_LIMIT },
  });
}

async function getQuota(event: ApiEvent) {
  const who = claims(event);
  const today = new Date().toISOString().slice(0, 10);
  const [userUsed, globalUsed] = await Promise.all([
    readCounter(today, `USER#${who.sub}`),
    readCounter(today, 'GLOBAL'),
  ]);
  return json(200, {
    userUsed,
    userLimit: USER_DAILY_LIMIT,
    globalUsed,
    globalLimit: GLOBAL_DAILY_LIMIT,
  });
}

async function getAnonQuota(event: ApiEvent) {
  const who = visitor(event);
  const today = new Date().toISOString().slice(0, 10);
  const [anonUsed, poolUsed, globalUsed] = await Promise.all([
    readCounter(today, `ANON#${who.sub}`),
    readCounter(today, 'ANON-GLOBAL'),
    readCounter(today, 'GLOBAL'),
  ]);
  return json(200, {
    anonId: who.sub,
    anonUsed,
    anonLimit: ANON_DAILY_LIMIT,
    poolUsed,
    poolLimit: ANON_GLOBAL_DAILY_LIMIT,
    globalExhausted: globalUsed >= GLOBAL_DAILY_LIMIT,
  });
}

export const handler = router({
  'GET /api/public/documents': listDocuments,
  'GET /api/public/documents/{id}': getDocument,
  'GET /api/public/search': searchArchive,
  'POST /api/public/uploads': (event) => issueUpload(event, true),
  'GET /api/public/uploads/quota': getAnonQuota,
  'POST /api/uploads': (event) => issueUpload(event, false),
  'GET /api/me/quota': getQuota,
});
