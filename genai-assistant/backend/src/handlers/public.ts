import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { HttpError, json, router, type ApiEvent } from '../lib/http.js';
import type { IndexMeta } from '../lib/retrieval.js';

const BUCKET = process.env.CORPUS_BUCKET!;
const USER_DAILY_LIMIT = Number(process.env.USER_DAILY_LIMIT ?? 40);
const GLOBAL_DAILY_LIMIT = Number(process.env.GLOBAL_DAILY_LIMIT ?? 200);
const ANON_DAILY_LIMIT = Number(process.env.ANON_DAILY_LIMIT ?? 5);
const ANON_GLOBAL_DAILY_LIMIT = Number(process.env.ANON_GLOBAL_DAILY_LIMIT ?? 30);

const s3 = new S3Client({});

// The anonymous read-only side of the plank: corpus metadata for the landing
// page and the corpus documents themselves for the reading room. This Lambda
// physically cannot reach Bedrock — its role can s3:GetObject the index
// metadata and corpus/*.md, and nothing else.
let metaCache: { at: number; meta: IndexMeta } | null = null;
const docCache = new Map<string, { at: number; markdown: string }>();

async function loadMeta(): Promise<IndexMeta> {
  if (!metaCache || Date.now() - metaCache.at > 60_000) {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'index/meta.json' }));
    metaCache = { at: Date.now(), meta: JSON.parse(await res.Body!.transformToString()) as IndexMeta };
  }
  return metaCache.meta;
}

async function getDoc(event: ApiEvent) {
  const name = event.queryStringParameters?.name ?? '';
  // Strict allowlist shape, then membership in the indexed doc list: no
  // traversal, no reaching outside corpus/, no unindexed objects.
  if (!/^[a-z0-9][a-z0-9-]*\.md$/i.test(name)) throw new HttpError(400, 'Invalid document name');
  const meta = await loadMeta();
  if (!meta.docList?.some((d) => d.doc === name)) throw new HttpError(404, 'No such document');

  let cached = docCache.get(name);
  if (!cached || Date.now() - cached.at > 60_000) {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `corpus/${name}` }));
    cached = { at: Date.now(), markdown: await res.Body!.transformToString() };
    docCache.set(name, cached);
  }
  return json(200, { doc: name, markdown: cached.markdown });
}

export const handler = router({
  'GET /api/public/info': async () => {
    const meta = await loadMeta();
    return json(200, {
      corpus: meta,
      answerModel: 'Claude Haiku 4.5 (Amazon Bedrock)',
      limits: {
        perUserDaily: USER_DAILY_LIMIT,
        globalDaily: GLOBAL_DAILY_LIMIT,
        visitorDaily: ANON_DAILY_LIMIT,
        visitorPoolDaily: ANON_GLOBAL_DAILY_LIMIT,
      },
    });
  },
  'GET /api/public/doc': getDoc,
});
