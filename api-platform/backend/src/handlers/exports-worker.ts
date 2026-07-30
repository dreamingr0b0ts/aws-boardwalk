// Exports microservice, worker half — consumes the job queue, reads the
// requested catalog, writes the artifact to the private exports bucket, and
// stamps the job record done. Its role is the only one in the plank allowed
// to read across the three catalog tables; it can read them, never write.
import type { SQSEvent } from 'aws-lambda';
import { GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ddb } from '../lib/ddb.js';

const JOBS_TABLE = process.env.JOBS_TABLE!;
const BUCKET = process.env.BUCKET!;
// { "permits": "<table>", "licenses": "<table>", "facilities": "<table>" }
const SERVICE_TABLES: Record<string, string> = JSON.parse(process.env.SERVICE_TABLES_JSON!);

const s3 = new S3Client({});

// Stable public column order per service; also the CSV header row.
const COLUMNS: Record<string, string[]> = {
  permits: ['id', 'type', 'status', 'description', 'address', 'applicant', 'valuation', 'submittedAt'],
  licenses: ['id', 'businessName', 'category', 'status', 'address', 'issuedAt', 'expiresAt'],
  facilities: ['id', 'name', 'kind', 'address', 'status'],
};

async function scanAll(table: string, service: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res: { Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> } = await ddb.send(
      new ScanCommand({ TableName: table, ExclusiveStartKey: startKey })
    );
    items.push(...(res.Items ?? []));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  // The permits table is single-table (inspections, idempotency records);
  // an export is the permit catalog only.
  const records = service === 'permits' ? items.filter((i) => i.SK === 'META') : items;
  // Project onto the public columns — key attributes and ttl never leave.
  return records.map((item) => Object.fromEntries(COLUMNS[service].map((c) => [c, item[c] ?? null])));
}

function csvCell(value: unknown): string {
  const s = value == null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function serialize(service: string, format: string, records: Record<string, unknown>[]): { body: string; contentType: string } {
  if (format === 'csv') {
    const cols = COLUMNS[service];
    const lines = [cols.join(','), ...records.map((r) => cols.map((c) => csvCell(r[c])).join(','))];
    return { body: lines.join('\n') + '\n', contentType: 'text/csv; charset=utf-8' };
  }
  return {
    body: JSON.stringify({ service, exportedAt: new Date().toISOString(), count: records.length, items: records }, null, 2),
    contentType: 'application/json; charset=utf-8',
  };
}

async function setJob(id: string, fields: Record<string, unknown>): Promise<void> {
  const names = Object.fromEntries(Object.keys(fields).map((k) => [`#${k}`, k]));
  const values = Object.fromEntries(Object.entries(fields).map(([k, v]) => [`:${k}`, v]));
  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { id },
      UpdateExpression: `SET ${Object.keys(fields).map((k) => `#${k} = :${k}`).join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );
}

export const handler = async (event: SQSEvent) => {
  for (const record of event.Records) {
    const { id } = JSON.parse(record.body) as { id: string };
    const job = await ddb.send(new GetCommand({ TableName: JOBS_TABLE, Key: { id } }));
    if (!job.Item) {
      console.error('export job vanished', id);
      continue;
    }
    const { service, format } = job.Item as { service: string; format: string };
    try {
      await setJob(id, { status: 'running', startedAt: new Date().toISOString() });
      const records = await scanAll(SERVICE_TABLES[service], service);
      const { body, contentType } = serialize(service, format, records);
      const objectKey = `exports/${id}.${format}`;
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: objectKey, Body: body, ContentType: contentType }));
      await setJob(id, {
        status: 'done',
        completedAt: new Date().toISOString(),
        objectKey,
        count: records.length,
        sizeBytes: Buffer.byteLength(body),
      });
    } catch (err) {
      // App-level failure is recorded on the job (the API reports it
      // honestly); rethrowing would only replay a deterministic failure.
      console.error('export failed', id, err);
      await setJob(id, { status: 'failed', completedAt: new Date().toISOString(), error: 'export failed; see service logs' });
    }
  }
};
