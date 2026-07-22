import {
  GetDocumentAnalysisCommand,
  StartDocumentAnalysisCommand,
  TextractClient,
  type Block,
} from '@aws-sdk/client-textract';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PDFDocument } from 'pdf-lib';
import { putDoc, updateDoc, type DocRecord, type KvPair } from '../lib/store.js';

const BUCKET = process.env.DOCS_BUCKET!;
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 4 * 1024 * 1024);
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 6);
const MAX_POLLS = 40; // × the state machine's 4s wait ≈ 2.7 min OCR budget

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
  const source = head.Metadata?.source === 'seed' ? 'seed' : 'upload';

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
      FeatureTypes: ['FORMS'],
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

  const lines = blocks.filter((b) => b.BlockType === 'LINE');
  const byPage = new Map<number, string[]>();
  for (const line of lines) {
    const page = line.Page ?? 1;
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page)!.push(line.Text ?? '');
  }
  const pageTexts = [...byPage.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l.join('\n'));
  const text = pageTexts.join('\n\n');
  const avgConfidence = lines.length
    ? lines.reduce((sum, l) => sum + (l.Confidence ?? 0), 0) / lines.length
    : 0;

  const kv = parseForms(blocks);

  const extractKey = `extracted/${docId}.json`;
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: extractKey,
      ContentType: 'application/json',
      Body: JSON.stringify({ docId, text, pages: pageTexts, kv, avgConfidence }),
    })
  );

  await updateDoc(
    docId,
    {
      pages: first.DocumentMetadata?.Pages ?? pageTexts.length,
      ocrConfidence: Math.round(avgConfidence * 10) / 10,
      textChars: text.length,
      textPreview: text.slice(0, 600),
      kvPairs: kv.slice(0, 40),
      extractKey,
    },
    'ocr-complete'
  );

  return { docId, rejected: false, jobId, pollCount, done: true };
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
    const value = (block.Relationships ?? [])
      .filter((r) => r.Type === 'VALUE')
      .flatMap((r) => r.Ids ?? [])
      .map((id) => byId.get(id))
      .filter((v): v is Block => Boolean(v))
      .map(childText)
      .join(' ')
      .trim();
    pairs.push({ key, value, confidence: Math.round((block.Confidence ?? 0) * 10) / 10 });
  }
  return pairs.sort((a, b) => b.confidence - a.confidence);
}
