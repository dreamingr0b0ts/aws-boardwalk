import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { ComprehendClient, ContainsPiiEntitiesCommand, DetectEntitiesCommand } from '@aws-sdk/client-comprehend';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getDoc, updateDoc, type Entity } from '../lib/store.js';

const BUCKET = process.env.DOCS_BUCKET!;
const MODEL_ID = process.env.MODEL_ID!;

// Comprehend bills per 100-character unit, so the analysis window is the
// per-document NLP cost ceiling (~9000 chars ≈ one cent per document).
const ANALYSIS_CHARS = 9000;
const CLASSIFY_EXCERPT_CHARS = 2800;
const MAX_ENTITIES = 30;
const MIN_ENTITY_SCORE = 0.5;

const DOC_TYPES = [
  'permit-application',
  'inspection-report',
  'license-certificate',
  'invoice',
  'violation-notice',
  'meeting-minutes',
  'correspondence',
  'other',
];

const s3 = new S3Client({});
const comprehend = new ComprehendClient({});
const bedrock = new BedrockRuntimeClient({});

interface EnrichInput {
  step: 'entities' | 'classify' | 'index';
  docId: string;
}

export async function handler(event: EnrichInput): Promise<{ docId: string }> {
  if (event.step === 'entities') await entities(event.docId);
  else if (event.step === 'classify') await classify(event.docId);
  else await index(event.docId);
  return { docId: event.docId };
}

async function extractedText(docId: string): Promise<string> {
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `extracted/${docId}.json` }));
  const extraction = JSON.parse(await obj.Body!.transformToString()) as { text: string };
  return extraction.text;
}

/** Comprehend pass: named entities for the facet index, plus a PII flag. */
async function entities(docId: string): Promise<void> {
  const text = (await extractedText(docId)).slice(0, ANALYSIS_CHARS);
  if (!text.trim()) {
    await updateDoc(docId, { entities: [], entityCount: 0, hasPii: false, piiLabels: [] }, 'entities-complete');
    return;
  }

  const [detected, pii] = await Promise.all([
    comprehend.send(new DetectEntitiesCommand({ Text: text, LanguageCode: 'en' })),
    comprehend.send(new ContainsPiiEntitiesCommand({ Text: text, LanguageCode: 'en' })),
  ]);

  const seen = new Set<string>();
  const found: Entity[] = [];
  for (const e of (detected.Entities ?? []).sort((a, b) => (b.Score ?? 0) - (a.Score ?? 0))) {
    if ((e.Score ?? 0) < MIN_ENTITY_SCORE || !e.Text || !e.Type) continue;
    const dedupe = `${e.Type}:${e.Text.toLowerCase()}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    found.push({ text: e.Text, type: e.Type, score: Math.round((e.Score ?? 0) * 100) / 100 });
    if (found.length >= MAX_ENTITIES) break;
  }

  const piiLabels = (pii.Labels ?? [])
    .filter((l) => (l.Score ?? 0) >= 0.6 && l.Name)
    .map((l) => String(l.Name));

  await updateDoc(
    docId,
    { entities: found, entityCount: found.length, hasPii: piiLabels.length > 0, piiLabels },
    'entities-complete'
  );
}

const CLASSIFY_SYSTEM = `You classify scanned municipal documents for a records-management index. Given a document's filename, extracted form fields, and text excerpt, respond with ONLY a JSON object (no prose, no code fences):
{"docType": "<one of: ${DOC_TYPES.join(', ')}>", "confidence": <0.0-1.0>, "title": "<short human-readable title, max 70 chars>", "summary": "<1-2 sentence plain-language summary>", "docDate": "<primary date on the document as YYYY-MM-DD, or null>"}`;

/** Bedrock pass: document type, display title, summary, and primary date. */
async function classify(docId: string): Promise<void> {
  const [doc, text] = await Promise.all([getDoc(docId), extractedText(docId)]);

  const kvLines = (doc?.kvPairs ?? [])
    .slice(0, 20)
    .map((p) => `${p.key}: ${p.value}`)
    .join('\n');

  const res = await bedrock.send(
    new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 350,
        system: CLASSIFY_SYSTEM,
        messages: [
          {
            role: 'user',
            content: `Filename: ${doc?.filename ?? 'unknown'}\n\nForm fields:\n${kvLines || '(none detected)'}\n\nText excerpt:\n${text.slice(0, CLASSIFY_EXCERPT_CHARS)}`,
          },
        ],
      }),
    })
  );

  const payload = JSON.parse(new TextDecoder().decode(res.body)) as { content: { type: string; text?: string }[] };
  const raw = payload.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');

  let parsed: { docType?: string; confidence?: number; title?: string; summary?: string; docDate?: string | null } = {};
  try {
    parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
  } catch {
    console.error('classification not parseable', raw);
  }

  await updateDoc(
    docId,
    {
      docType: DOC_TYPES.includes(parsed.docType ?? '') ? parsed.docType : 'other',
      docTypeConfidence: Math.min(1, Math.max(0, Number(parsed.confidence ?? 0.3))),
      title: String(parsed.title ?? doc?.filename ?? docId).slice(0, 90),
      summary: String(parsed.summary ?? 'No summary available.').slice(0, 400),
      docDate: /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.docDate)) ? parsed.docDate : null,
    },
    'classified'
  );
}

/** Final state flip: the document becomes visible as INDEXED in the search UI. */
async function index(docId: string): Promise<void> {
  const doc = await getDoc(docId);
  const fields: Record<string, unknown> = { status: 'INDEXED' };
  // Uploads are transient demo artifacts: TTL is the backstop, the nightly
  // reset is the broom. Seeds are the permanent browsable corpus.
  if (doc?.source === 'upload') fields.ttl = Math.floor(Date.now() / 1000) + 72 * 3600;
  await updateDoc(docId, fields, 'indexed');
}
