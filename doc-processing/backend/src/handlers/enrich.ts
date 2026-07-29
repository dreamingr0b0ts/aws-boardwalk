import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { ComprehendClient, DetectEntitiesCommand, DetectPiiEntitiesCommand } from '@aws-sdk/client-comprehend';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { round6, spanBoxes, type WordRef } from '../lib/geometry.js';
import { getDoc, updateDoc, type Entity, type PiiHit } from '../lib/store.js';

const BUCKET = process.env.DOCS_BUCKET!;
const MODEL_ID = process.env.MODEL_ID!;

// Comprehend bills per 100-character unit, so the analysis window is the
// per-document NLP cost ceiling (~9000 chars ≈ one cent per document).
const ANALYSIS_CHARS = 9000;
const CLASSIFY_EXCERPT_CHARS = 2800;
const MAX_ENTITIES = 30;
const MIN_ENTITY_SCORE = 0.5;
const MIN_PII_SCORE = 0.5;
const MAX_PII_HITS = 40;

// Receipt inputs (see ../infra/variables.tf for the sourced prices)
const PRICE_COMPREHEND_PER_UNIT = Number(process.env.PRICE_COMPREHEND_PER_UNIT ?? 0.0001);
const PRICE_IN_PER_MTOK = Number(process.env.PRICE_IN_PER_MTOK ?? 1);
const PRICE_OUT_PER_MTOK = Number(process.env.PRICE_OUT_PER_MTOK ?? 5);

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

interface Extraction {
  text: string;
  words?: WordRef[];
}

async function extraction(docId: string): Promise<Extraction> {
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `extracted/${docId}.json` }));
  return JSON.parse(await obj.Body!.transformToString()) as Extraction;
}

/** Comprehend pass: named entities for the facet index, plus PII spans mapped to redaction geometry. */
async function entities(docId: string): Promise<void> {
  const ex = await extraction(docId);
  const text = ex.text.slice(0, ANALYSIS_CHARS);
  if (!text.trim()) {
    await updateDoc(
      docId,
      { entities: [], entityCount: 0, hasPii: false, piiLabels: [], piiEntities: [], comprehendUnits: 0, costComprehend: 0 },
      'entities-complete'
    );
    return;
  }

  const [detected, pii] = await Promise.all([
    comprehend.send(new DetectEntitiesCommand({ Text: text, LanguageCode: 'en' })),
    comprehend.send(new DetectPiiEntitiesCommand({ Text: text, LanguageCode: 'en' })),
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

  // The record keeps the TYPE and the page geometry of each PII span, never
  // the detected value: the public API can then drive redaction bars without
  // itself becoming a PII disclosure.
  const words = ex.words ?? [];
  const piiEntities: PiiHit[] = [];
  for (const p of (pii.Entities ?? []).sort((a, b) => (a.BeginOffset ?? 0) - (b.BeginOffset ?? 0))) {
    if ((p.Score ?? 0) < MIN_PII_SCORE || !p.Type || p.BeginOffset === undefined || p.EndOffset === undefined) continue;
    piiEntities.push({
      type: p.Type,
      score: Math.round((p.Score ?? 0) * 100) / 100,
      boxes: spanBoxes(words, p.BeginOffset, p.EndOffset),
    });
    if (piiEntities.length >= MAX_PII_HITS) break;
  }
  const piiLabels = [...new Set(piiEntities.map((p) => p.type))];

  // Both detection calls ran over the same window: units = 2 × ceil(chars/100)
  // with Comprehend's 3-unit minimum per request.
  const unitsPerCall = Math.max(3, Math.ceil(text.length / 100));
  const comprehendUnits = unitsPerCall * 2;

  await updateDoc(
    docId,
    {
      entities: found,
      entityCount: found.length,
      hasPii: piiEntities.length > 0,
      piiLabels,
      piiEntities,
      comprehendUnits,
      costComprehend: round6(comprehendUnits * PRICE_COMPREHEND_PER_UNIT),
    },
    'entities-complete'
  );
}

const CLASSIFY_SYSTEM = `You classify scanned municipal documents for a records-management index. Given a document's filename, extracted form fields, and text excerpt, respond with ONLY a JSON object (no prose, no code fences):
{"docType": "<one of: ${DOC_TYPES.join(', ')}>", "confidence": <0.0-1.0>, "title": "<short human-readable title, max 70 chars>", "summary": "<1-2 sentence plain-language summary>", "docDate": "<primary date on the document as YYYY-MM-DD, or null>"}`;

/** Bedrock pass: document type, display title, summary, and primary date. */
async function classify(docId: string): Promise<void> {
  const [doc, ex] = await Promise.all([getDoc(docId), extraction(docId)]);

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
            content: `Filename: ${doc?.filename ?? 'unknown'}\n\nForm fields:\n${kvLines || '(none detected)'}\n\nText excerpt:\n${ex.text.slice(0, CLASSIFY_EXCERPT_CHARS)}`,
          },
        ],
      }),
    })
  );

  const payload = JSON.parse(new TextDecoder().decode(res.body)) as {
    content: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const raw = payload.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  const tokensIn = payload.usage?.input_tokens ?? 0;
  const tokensOut = payload.usage?.output_tokens ?? 0;

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
      tokensIn,
      tokensOut,
      costBedrock: round6((tokensIn * PRICE_IN_PER_MTOK + tokensOut * PRICE_OUT_PER_MTOK) / 1e6),
    },
    'classified'
  );
}

/**
 * Final state flip: assemble the processing receipt, roll up the
 * human-review verdict, and become INDEXED.
 */
async function index(docId: string): Promise<void> {
  const doc = await getDoc(docId);
  const textract = doc?.costTextract ?? 0;
  const queries = doc?.costQueries ?? 0;
  const comprehendCost = doc?.costComprehend ?? 0;
  const bedrockCost = doc?.costBedrock ?? 0;
  const fields: Record<string, unknown> = {
    status: 'INDEXED',
    cost: {
      textract,
      queries,
      comprehend: comprehendCost,
      bedrock: bedrockCost,
      total: round6(textract + queries + comprehendCost + bedrockCost),
    },
    // Triage without A2I: repeated low-confidence extraction or a hesitant
    // classifier marks the document for a human pass before its metadata is
    // trusted. The bar is three flagged fields, not one: almost every scan
    // has a stray heading artifact or two, and a queue that flags everything
    // flags nothing (the seed corpus lands at 4 of 8 in the queue).
    needsReview: (doc?.reviewFields ?? 0) >= 3 || (doc?.docTypeConfidence ?? 1) < 0.7,
  };
  // Uploads are transient demo artifacts: TTL is the backstop, the nightly
  // reset is the broom. Anonymous uploads live 24h at most; credentialed ones
  // 72h. Seeds are the permanent browsable corpus.
  if (doc?.source === 'upload') fields.ttl = Math.floor(Date.now() / 1000) + 72 * 3600;
  if (doc?.source === 'anon') fields.ttl = Math.floor(Date.now() / 1000) + 24 * 3600;
  await updateDoc(docId, fields, 'indexed');
}
