import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

export const TABLE = process.env.TABLE_NAME!;

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export const docKey = (docId: string) => ({ PK: `DOC#${docId}`, SK: 'META' });

// Pipeline lifecycle. Every step transition is appended to the item's `steps`
// timeline so the UI can replay exactly what happened to a document and when.
export type DocStatus = 'PROCESSING' | 'INDEXED' | 'REJECTED' | 'FAILED';

/**
 * A region on a page, in Textract's normalized page coordinates (0-1 from the
 * top-left). `p` is the 1-based page number. Kept terse because boxes ride on
 * DynamoDB records and the public API.
 */
export interface Box {
  p: number;
  l: number;
  t: number;
  w: number;
  h: number;
}

export interface KvPair {
  key: string;
  value: string;
  confidence: number;
  keyBox?: Box;
  valueBox?: Box;
}

export interface Entity {
  text: string;
  type: string;
  score: number;
}

/**
 * One PII finding mapped back onto the page. Deliberately carries NO text:
 * the type and where to draw the redaction bars are all the UI needs, and the
 * detected value itself never lands in DynamoDB or the public API.
 */
export interface PiiHit {
  type: string;
  score: number;
  boxes: Box[];
}

/** One Textract Queries answer, with where on the page it was found. */
export interface QueryAnswer {
  question: string;
  answer: string;
  confidence: number;
  box?: Box;
}

/** Per-document processing receipt, assembled at the index step. */
export interface CostReceipt {
  textract: number;
  queries: number;
  comprehend: number;
  bedrock: number;
  total: number;
}

export interface DocRecord {
  docId: string;
  status: DocStatus;
  filename: string;
  contentType: string;
  sizeBytes: number;
  source: 'seed' | 'upload' | 'anon';
  uploadedBy?: string;
  createdAt: string;
  s3Key: string;
  extractKey?: string;
  steps: { name: string; at: string }[];
  pages?: number;
  ocrConfidence?: number;
  textChars?: number;
  textPreview?: string;
  kvPairs?: KvPair[];
  entities?: Entity[];
  entityCount?: number;
  hasPii?: boolean;
  piiLabels?: string[];
  piiEntities?: PiiHit[];
  queryAnswers?: QueryAnswer[];
  reviewFields?: number;
  needsReview?: boolean;
  costTextract?: number;
  costQueries?: number;
  costComprehend?: number;
  comprehendUnits?: number;
  costBedrock?: number;
  tokensIn?: number;
  tokensOut?: number;
  cost?: CostReceipt;
  docType?: string;
  docTypeConfidence?: number;
  title?: string;
  summary?: string;
  docDate?: string | null;
  rejectReason?: string;
  error?: string;
}

// ---- upload grants ---------------------------------------------------------
//
// A presigned POST stays valid until it expires, and S3 will accept it any
// number of times: each re-POST overwrites the object and fires another
// "Object Created" event. The daily counters are only bumped when the grant
// is issued, so without this record one grant could start the paid pipeline
// over and over. Each grant therefore leaves one GRANT item, and a pipeline
// run has to claim it before it may spend anything. The first run wins; every
// later event for the same key finds the grant taken and exits for free.

export const grantKey = (docId: string) => ({ PK: `DOC#${docId}`, SK: 'GRANT' });

const GRANT_TTL_SECONDS = 3600;

/** Record that an upload to exactly `s3Key` has been paid for in the counters. */
export async function putGrant(docId: string, s3Key: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: grantKey(docId),
      UpdateExpression: 'SET #k = :key, #ttl = :ttl',
      ExpressionAttributeNames: { '#k': 's3Key', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':key': s3Key, ':ttl': Math.floor(Date.now() / 1000) + GRANT_TTL_SECONDS },
    })
  );
}

/**
 * Claim a grant for one pipeline run. Returns false when there is no grant
 * for this key or another run already holds it. Claiming again with the same
 * `runId` succeeds, so a Step Functions retry of the same execution is not
 * mistaken for a replay.
 */
export async function claimGrant(docId: string, s3Key: string, runId: string): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: grantKey(docId),
        UpdateExpression: 'SET #c = :run',
        ConditionExpression: '#k = :key AND (attribute_not_exists(#c) OR #c = :run)',
        ExpressionAttributeNames: { '#k': 's3Key', '#c': 'claimedBy' },
        ExpressionAttributeValues: { ':key': s3Key, ':run': runId },
      })
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

export async function getDoc(docId: string): Promise<DocRecord | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: docKey(docId) }));
  return res.Item as DocRecord | undefined;
}

export async function putDoc(item: DocRecord & { ttl?: number }): Promise<void> {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...docKey(item.docId), ...item } }));
}

/**
 * Merge fields into a document record and (optionally) append a named step to
 * its timeline. Attribute names are always aliased — several fields (status,
 * error, ttl) collide with DynamoDB reserved words.
 */
export async function updateDoc(docId: string, fields: Record<string, unknown>, stepName?: string): Promise<void> {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];

  Object.entries(fields).forEach(([k, v], i) => {
    names[`#f${i}`] = k;
    values[`:f${i}`] = v;
    sets.push(`#f${i} = :f${i}`);
  });

  if (stepName) {
    names['#steps'] = 'steps';
    values[':step'] = [{ name: stepName, at: new Date().toISOString() }];
    values[':noSteps'] = [];
    sets.push('#steps = list_append(if_not_exists(#steps, :noSteps), :step)');
  }

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: docKey(docId),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );
}
