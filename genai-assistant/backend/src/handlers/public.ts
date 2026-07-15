import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { json, router } from '../lib/http.js';
import type { IndexMeta } from '../lib/retrieval.js';

const BUCKET = process.env.CORPUS_BUCKET!;
const USER_DAILY_LIMIT = Number(process.env.USER_DAILY_LIMIT ?? 40);
const GLOBAL_DAILY_LIMIT = Number(process.env.GLOBAL_DAILY_LIMIT ?? 200);

const s3 = new S3Client({});

// The only anonymous route on the whole plank. It serves static corpus
// metadata for the landing page and physically cannot reach Bedrock — the
// Lambda role has s3:GetObject on exactly one key and nothing else.
let cache: { at: number; meta: IndexMeta } | null = null;

export const handler = router({
  'GET /api/public/info': async () => {
    if (!cache || Date.now() - cache.at > 60_000) {
      const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'index/meta.json' }));
      cache = { at: Date.now(), meta: JSON.parse(await res.Body!.transformToString()) as IndexMeta };
    }
    return json(200, {
      corpus: cache.meta,
      answerModel: 'Claude Haiku 4.5 (Amazon Bedrock)',
      limits: { perUserDaily: USER_DAILY_LIMIT, globalDaily: GLOBAL_DAILY_LIMIT },
    });
  },
});
