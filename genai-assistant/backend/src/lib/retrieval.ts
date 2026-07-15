import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

export const EMBED_DIMS = 512;

export interface Chunk {
  id: string;
  doc: string; // s3 key basename, e.g. building-permits.md
  title: string; // document H1
  section: string; // nearest H2 (or "Overview")
  text: string;
  vec: number[]; // unit-normalized, EMBED_DIMS long
}

export interface VectorIndex {
  meta: IndexMeta;
  chunks: Chunk[];
}

export interface IndexMeta {
  docs: number;
  chunks: number;
  dims: number;
  embedModel: string;
  updatedAt: string;
  titles: string[];
}

const s3 = new S3Client({});
const bedrock = new BedrockRuntimeClient({});

/** Embed one text with Titan v2; returns a unit-normalized vector. */
export async function embed(text: string, modelId: string): Promise<number[]> {
  const res = await bedrock.send(
    new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ inputText: text.slice(0, 8000), dimensions: EMBED_DIMS, normalize: true }),
    })
  );
  const parsed = JSON.parse(new TextDecoder().decode(res.body)) as { embedding: number[] };
  return parsed.embedding;
}

// The whole index is a few hundred KB, so it lives in Lambda memory across
// invocations; the ETag check keeps a warm container in sync after re-ingest.
let cached: { etag: string; index: VectorIndex } | null = null;

export async function loadIndex(bucket: string): Promise<VectorIndex> {
  const res = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: 'index/vectors.json',
      IfNoneMatch: cached?.etag,
    })
  ).catch((err: { $metadata?: { httpStatusCode?: number } }) => {
    if (err.$metadata?.httpStatusCode === 304 && cached) return null;
    throw err;
  });
  if (res === null) return cached!.index;
  const body = await res.Body!.transformToString();
  cached = { etag: res.ETag ?? '', index: JSON.parse(body) as VectorIndex };
  return cached.index;
}

/** Vectors are unit-normalized, so cosine similarity is a plain dot product. */
export function topK(query: number[], chunks: Chunk[], k: number): { chunk: Chunk; score: number }[] {
  const scored = chunks.map((chunk) => {
    let dot = 0;
    for (let i = 0; i < query.length; i++) dot += query[i] * chunk.vec[i];
    return { chunk, score: dot };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
