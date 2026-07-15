import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { claims, HttpError, json, parseBody, requireString, router, type ApiEvent } from '../lib/http.js';
import { ddb, TABLE, type DocRecord } from '../lib/store.js';

const BUCKET = process.env.DOCS_BUCKET!;
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 4 * 1024 * 1024);
const USER_DAILY_LIMIT = Number(process.env.USER_DAILY_LIMIT ?? 8);
const GLOBAL_DAILY_LIMIT = Number(process.env.GLOBAL_DAILY_LIMIT ?? 20);

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
  return docs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 200);
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

// ---- authenticated routes (each accepted upload spends Textract/AI money) ----

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

interface UploadRequest {
  filename: string;
  contentType: string;
  sizeBytes: number;
}

/**
 * The cost gate, in order: JWT (API Gateway) → request validation → per-user
 * daily cap → global daily kill switch → only then a presigned POST whose
 * conditions re-pin key, content type, and size at the S3 door.
 */
async function createUpload(event: ApiEvent) {
  const who = claims(event);
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
  let userCount: number;
  try {
    userCount = await bumpCounter(today, `USER#${who.sub}`, USER_DAILY_LIMIT);
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw new HttpError(429, `Daily demo limit reached (${USER_DAILY_LIMIT} documents). Resets at 00:00 UTC.`);
    }
    throw err;
  }
  let globalCount: number;
  try {
    globalCount = await bumpCounter(today, 'GLOBAL', GLOBAL_DAILY_LIMIT);
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw new HttpError(429, 'The demo has reached its global daily budget. Try again after 00:00 UTC.');
    }
    throw err;
  }

  const docId = `${today.replaceAll('-', '')}-${randomUUID().slice(0, 8)}`;
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
      'x-amz-meta-source': 'upload',
      'x-amz-meta-uploader': who.email,
    },
    Expires: 300,
  });

  return json(200, {
    docId,
    upload: { url: post.url, fields: post.fields },
    quota: { userUsed: userCount, userLimit: USER_DAILY_LIMIT, globalUsed: globalCount, globalLimit: GLOBAL_DAILY_LIMIT },
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

export const handler = router({
  'GET /api/public/documents': listDocuments,
  'GET /api/public/documents/{id}': getDocument,
  'POST /api/uploads': createUpload,
  'GET /api/me/quota': getQuota,
});
