import {
  GetDocumentAnalysisCommand,
  StartDocumentAnalysisCommand,
  TextractClient,
  type Block,
} from '@aws-sdk/client-textract';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PDFDocument } from 'pdf-lib';
import { round4, round6, type WordRef } from '../lib/geometry.js';
import { putDoc, updateDoc, type Box, type DocRecord, type KvPair, type QueryAnswer } from '../lib/store.js';

const BUCKET = process.env.DOCS_BUCKET!;
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 4 * 1024 * 1024);
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 6);
const MAX_POLLS = 40; // × the state machine's 4s wait ≈ 2.7 min OCR budget
const PRICE_TEXTRACT_PER_PAGE = Number(process.env.PRICE_TEXTRACT_PER_PAGE ?? 0.05);
const PRICE_TEXTRACT_QUERIES_PER_PAGE = Number(process.env.PRICE_TEXTRACT_QUERIES_PER_PAGE ?? 0.015);

// Fields below this confidence get flagged "needs human review" — the
// triage a records clerk would run before trusting the extraction.
const REVIEW_CONFIDENCE = 90;

// The type isn't known until the Bedrock classify step, long after this job
// starts, so the query set is universal municipal-records vocabulary (the
// async API allows up to 15 queries; unanswerable ones simply return nothing).
const QUERIES = [
  { Text: 'What is the reference, permit, license, case, or invoice number?', Alias: 'ref_number' },
  { Text: 'What is the primary date on the document?', Alias: 'doc_date' },
  { Text: 'What is the total amount due or fee paid?', Alias: 'amount' },
  { Text: 'Who is the applicant, owner, or addressee?', Alias: 'person' },
  { Text: 'What is the property or business address?', Alias: 'address' },
  { Text: 'What is the deadline, due date, or expiration date?', Alias: 'deadline' },
  { Text: 'Who issued or signed the document?', Alias: 'issuer' },
  { Text: 'What phone number is listed?', Alias: 'phone' },
];

// Everything the async Textract API accepts. The page/size caps below are the
// plank's Textract cost ceiling: nothing over MAX_PAGES ever starts a job.
const ALLOWED_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'tif', 'tiff'];

const s3 = new S3Client({});
const textract = new TextractClient({});

interface StartInput {
  step: 'start';
  bucket: string;
  key: string;
}

interface PollInput {
  step: 'poll';
  docId: string;
  jobId: string;
  pollCount: number;
}

type PipelineOutput =
  | { docId: string; rejected: true }
  | { docId: string; rejected: false; jobId: string; pollCount: number; done?: boolean };

export async function handler(event: StartInput | PollInput): Promise<PipelineOutput> {
  if (event.step === 'start') return start(event);
  return poll(event);
}

/**
 * Validate the just-uploaded object, register the document record, and start
 * the async Textract FORMS analysis. Validation failures mark the record
 * REJECTED and end the pipeline without spending a Textract cent.
 */
async function start({ bucket, key }: StartInput): Promise<PipelineOutput> {
  const [prefix, docId, ...rest] = key.split('/');
  const filename = decodeURIComponent(rest.join('/'));
  if (prefix !== 'incoming' || !docId || !filename) throw new Error(`Unexpected object key: ${key}`);

  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const sizeBytes = head.ContentLength ?? 0;
  const metaSource = head.Metadata?.source;
  const source = metaSource === 'seed' ? 'seed' : metaSource === 'anon' ? 'anon' : 'upload';

  const base: DocRecord = {
    docId,
    status: 'PROCESSING',
    filename,
    contentType: head.ContentType ?? 'application/octet-stream',
    sizeBytes,
    source,
    uploadedBy: head.Metadata?.uploader,
    createdAt: new Date().toISOString(),
    s3Key: key,
    steps: [{ name: 'received', at: new Date().toISOString() }],
  };

  const reject = async (reason: string): Promise<PipelineOutput> => {
    await putDoc({ ...base, status: 'REJECTED', rejectReason: reason });
    return { docId, rejected: true };
  };

  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (!ALLOWED_EXTENSIONS.includes(ext)) return reject(`Unsupported file type .${ext}; PDF and image formats only`);
  if (sizeBytes < 1 || sizeBytes > MAX_UPLOAD_BYTES) {
    return reject(`File is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB; the demo cap is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  }

  if (ext === 'pdf') {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const bytes = await obj.Body!.transformToByteArray();
    let pageCount: number;
    try {
      const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      pageCount = pdf.getPageCount();
    } catch {
      return reject('File could not be parsed as a PDF');
    }
    if (pageCount > MAX_PAGES) {
      return reject(`Document has ${pageCount} pages; the demo cap is ${MAX_PAGES} pages per document`);
    }
  }

  await putDoc(base);

  const job = await textract.send(
    new StartDocumentAnalysisCommand({
      DocumentLocation: { S3Object: { Bucket: bucket, Name: key } },
      FeatureTypes: ['FORMS', 'QUERIES'],
      QueriesConfig: { Queries: QUERIES },
    })
  );
  await updateDoc(docId, {}, 'ocr-started');

  return { docId, rejected: false, jobId: job.JobId!, pollCount: 0 };
}

/**
 * Check the Textract job; when it completes, parse every block page into
 * plain text + key/value pairs, park the full extraction in S3, and put the
 * summary metadata on the document record.
 */
async function poll({ docId, jobId, pollCount }: PollInput): Promise<PipelineOutput> {
  const first = await textract.send(new GetDocumentAnalysisCommand({ JobId: jobId, MaxResults: 1000 }));

  if (first.JobStatus === 'IN_PROGRESS') {
    if (pollCount >= MAX_POLLS) throw new Error(`OCR timed out after ${MAX_POLLS} polls`);
    return { docId, rejected: false, jobId, pollCount: pollCount + 1, done: false };
  }
  if (first.JobStatus !== 'SUCCEEDED') {
    throw new Error(`Textract job ${first.JobStatus}: ${first.StatusMessage ?? 'no detail'}`);
  }

  const blocks: Block[] = [...(first.Blocks ?? [])];
  let nextToken = first.NextToken;
  while (nextToken) {
    const page = await textract.send(
      new GetDocumentAnalysisCommand({ JobId: jobId, MaxResults: 1000, NextToken: nextToken })
    );
    blocks.push(...(page.Blocks ?? []));
    nextToken = page.NextToken;
  }

  const { text, pageTexts, words, avgConfidence } = assembleText(blocks);
  const kv = parseForms(blocks);
  const queryAnswers = parseQueries(blocks);
  const pages = first.DocumentMetadata?.Pages ?? pageTexts.length;
  const storedKv = kv.slice(0, 40);

  const extractKey = `extracted/${docId}.json`;
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: extractKey,
      ContentType: 'application/json',
      // `words` maps every character offset of `text` back to page geometry —
      // the enrich step turns Comprehend PII offsets into redaction boxes.
      Body: JSON.stringify({ docId, text, pages: pageTexts, kv, avgConfidence, words }),
    })
  );

  await updateDoc(
    docId,
    {
      pages,
      ocrConfidence: Math.round(avgConfidence * 10) / 10,
      textChars: text.length,
      textPreview: text.slice(0, 600),
      kvPairs: storedKv,
      queryAnswers,
      reviewFields: storedKv.filter((p) => p.confidence < REVIEW_CONFIDENCE).length,
      extractKey,
      costTextract: round6(pages * PRICE_TEXTRACT_PER_PAGE),
      costQueries: round6(pages * PRICE_TEXTRACT_QUERIES_PER_PAGE),
    },
    'ocr-complete'
  );

  return { docId, rejected: false, jobId, pollCount, done: true };
}

function bbox(block: Block): Box | undefined {
  const b = block.Geometry?.BoundingBox;
  if (!b) return undefined;
  return {
    p: block.Page ?? 1,
    l: round4(b.Left ?? 0),
    t: round4(b.Top ?? 0),
    w: round4(b.Width ?? 0),
    h: round4(b.Height ?? 0),
  };
}

/**
 * Rebuild the document text from each LINE's child WORD blocks (rather than
 * trusting LINE.Text) so every word's character offsets in the final string
 * are exact — the offsets Comprehend returns later index into this exact
 * string, and the word map is how they become redaction geometry.
 */
function assembleText(blocks: Block[]): {
  text: string;
  pageTexts: string[];
  words: WordRef[];
  avgConfidence: number;
} {
  const byId = new Map(blocks.map((b) => [b.Id!, b]));
  const lines = blocks.filter((b) => b.BlockType === 'LINE');
  const byPage = new Map<number, Block[]>();
  for (const line of lines) {
    const page = line.Page ?? 1;
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page)!.push(line);
  }

  const words: WordRef[] = [];
  const pageTexts: string[] = [];
  let cursor = 0;

  for (const [, pageLines] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    if (pageTexts.length) cursor += 2; // the '\n\n' page joiner
    let pageText = '';
    for (const line of pageLines) {
      if (pageText) {
        pageText += '\n';
        cursor += 1;
      }
      const lineWords = (line.Relationships ?? [])
        .filter((r) => r.Type === 'CHILD')
        .flatMap((r) => r.Ids ?? [])
        .map((id) => byId.get(id))
        .filter((b): b is Block => b?.BlockType === 'WORD' && Boolean(b.Text));
      lineWords.forEach((word, i) => {
        if (i > 0) {
          pageText += ' ';
          cursor += 1;
        }
        const t = word.Text!;
        const box = bbox(word);
        if (box) words.push({ start: cursor, end: cursor + t.length, box });
        pageText += t;
        cursor += t.length;
      });
    }
    pageTexts.push(pageText);
  }

  const avgConfidence = lines.length
    ? lines.reduce((sum, l) => sum + (l.Confidence ?? 0), 0) / lines.length
    : 0;

  return { text: pageTexts.join('\n\n'), pageTexts, words, avgConfidence };
}

/**
 * Textract QUERIES walk: QUERY blocks → their ANSWER QUERY_RESULT blocks.
 * Multi-page documents answer each query per page; keep the highest-
 * confidence answer per question.
 */
function parseQueries(blocks: Block[]): QueryAnswer[] {
  const byId = new Map(blocks.map((b) => [b.Id!, b]));
  const best = new Map<string, QueryAnswer>();
  for (const block of blocks) {
    if (block.BlockType !== 'QUERY' || !block.Query?.Text) continue;
    const question = block.Query.Text;
    for (const rel of block.Relationships ?? []) {
      if (rel.Type !== 'ANSWER') continue;
      for (const id of rel.Ids ?? []) {
        const r = byId.get(id);
        if (r?.BlockType !== 'QUERY_RESULT' || !r.Text) continue;
        const confidence = Math.round((r.Confidence ?? 0) * 10) / 10;
        const prev = best.get(question);
        if (prev && prev.confidence >= confidence) continue;
        best.set(question, { question, answer: r.Text, confidence, box: bbox(r) });
      }
    }
  }
  return [...best.values()].sort((a, b) => b.confidence - a.confidence);
}

/** Standard Textract FORMS walk: KEY blocks → their VALUE blocks → child words. */
function parseForms(blocks: Block[]): KvPair[] {
  const byId = new Map(blocks.map((b) => [b.Id!, b]));

  const childText = (block: Block): string =>
    (block.Relationships ?? [])
      .filter((r) => r.Type === 'CHILD')
      .flatMap((r) => r.Ids ?? [])
      .map((id) => byId.get(id))
      .map((child) => {
        if (child?.BlockType === 'WORD') return child.Text ?? '';
        if (child?.BlockType === 'SELECTION_ELEMENT') return child.SelectionStatus === 'SELECTED' ? '[x]' : '[ ]';
        return '';
      })
      .filter(Boolean)
      .join(' ');

  const pairs: KvPair[] = [];
  for (const block of blocks) {
    if (block.BlockType !== 'KEY_VALUE_SET' || !block.EntityTypes?.includes('KEY')) continue;
    const key = childText(block).replace(/[:：]\s*$/, '').trim();
    if (!key) continue;
    const valueBlocks = (block.Relationships ?? [])
      .filter((r) => r.Type === 'VALUE')
      .flatMap((r) => r.Ids ?? [])
      .map((id) => byId.get(id))
      .filter((v): v is Block => Boolean(v));
    const value = valueBlocks.map(childText).join(' ').trim();
    pairs.push({
      key,
      value,
      confidence: Math.round((block.Confidence ?? 0) * 10) / 10,
      keyBox: bbox(block),
      valueBox: valueBlocks.map(bbox).find(Boolean),
    });
  }
  return pairs.sort((a, b) => b.confidence - a.confidence);
}
