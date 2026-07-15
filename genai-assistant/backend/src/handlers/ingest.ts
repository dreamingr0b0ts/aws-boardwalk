import { S3Client, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { embed, EMBED_DIMS, type Chunk, type IndexMeta } from '../lib/retrieval.js';

const BUCKET = process.env.CORPUS_BUCKET!;
const EMBED_MODEL_ID = process.env.EMBED_MODEL_ID!;

const TARGET_CHUNK_CHARS = 1400;

const s3 = new S3Client({});

// Invoked by `make corpus` (not wired to any API route). Reads every
// corpus/*.md, chunks by H2 section, embeds with Titan v2, and writes the
// whole index as one JSON object — the corpus is swappable per pursuit by
// syncing different markdown and re-running this.

interface ParsedDoc {
  doc: string;
  title: string;
  sections: { section: string; text: string }[];
}

function parseMarkdown(doc: string, raw: string): ParsedDoc {
  const lines = raw.split('\n');
  let title = doc;
  const sections: { section: string; text: string }[] = [];
  let current = { section: 'Overview', body: [] as string[] };

  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)/);
    const h2 = line.match(/^##\s+(.+)/);
    if (h1) {
      title = h1[1].trim();
    } else if (h2) {
      if (current.body.join('\n').trim()) sections.push({ section: current.section, text: current.body.join('\n').trim() });
      current = { section: h2[1].trim(), body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.join('\n').trim()) sections.push({ section: current.section, text: current.body.join('\n').trim() });
  return { doc, title, sections };
}

/** Split an oversized section on paragraph boundaries. */
function splitLong(text: string): string[] {
  if (text.length <= TARGET_CHUNK_CHARS) return [text];
  const paras = text.split(/\n\n+/);
  const out: string[] = [];
  let buf = '';
  for (const p of paras) {
    if (buf && buf.length + p.length > TARGET_CHUNK_CHARS) {
      out.push(buf.trim());
      buf = '';
    }
    buf += p + '\n\n';
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

export async function handler(): Promise<IndexMeta> {
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'corpus/' }));
  const keys = (listed.Contents ?? []).map((o) => o.Key!).filter((k) => k.endsWith('.md'));
  if (keys.length === 0) throw new Error('No corpus/*.md objects found — run `make corpus` first');

  const chunks: Chunk[] = [];
  const titles: string[] = [];

  for (const key of keys) {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const raw = await res.Body!.transformToString();
    const docName = key.replace(/^corpus\//, '');
    const parsed = parseMarkdown(docName, raw);
    titles.push(parsed.title);

    for (const { section, text } of parsed.sections) {
      for (const [i, piece] of splitLong(text).entries()) {
        // Prefix with title/section so the embedding carries document context.
        const vec = await embed(`${parsed.title} — ${section}\n${piece}`, EMBED_MODEL_ID);
        chunks.push({
          id: `${docName}#${section}#${i}`,
          doc: docName,
          title: parsed.title,
          section,
          text: piece,
          vec,
        });
      }
    }
  }

  const meta: IndexMeta = {
    docs: keys.length,
    chunks: chunks.length,
    dims: EMBED_DIMS,
    embedModel: EMBED_MODEL_ID,
    updatedAt: new Date().toISOString(),
    titles,
  };

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: 'index/vectors.json',
      ContentType: 'application/json',
      Body: JSON.stringify({ meta, chunks }),
    })
  );
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: 'index/meta.json',
      ContentType: 'application/json',
      Body: JSON.stringify(meta),
    })
  );

  console.log(`indexed ${chunks.length} chunks from ${keys.length} docs`);
  return meta;
}
