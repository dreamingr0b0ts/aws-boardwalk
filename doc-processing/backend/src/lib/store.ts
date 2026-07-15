import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

export const TABLE = process.env.TABLE_NAME!;

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export const docKey = (docId: string) => ({ PK: `DOC#${docId}`, SK: 'META' });

// Pipeline lifecycle. Every step transition is appended to the item's `steps`
// timeline so the UI can replay exactly what happened to a document and when.
export type DocStatus = 'PROCESSING' | 'INDEXED' | 'REJECTED' | 'FAILED';

export interface KvPair {
  key: string;
  value: string;
  confidence: number;
}

export interface Entity {
  text: string;
  type: string;
  score: number;
}

export interface DocRecord {
  docId: string;
  status: DocStatus;
  filename: string;
  contentType: string;
  sizeBytes: number;
  source: 'seed' | 'upload';
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
  docType?: string;
  docTypeConfidence?: number;
  title?: string;
  summary?: string;
  docDate?: string | null;
  rejectReason?: string;
  error?: string;
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
