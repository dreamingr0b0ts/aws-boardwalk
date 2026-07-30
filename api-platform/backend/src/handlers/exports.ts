// Exports microservice, API half — the async-job pattern every integrator
// eventually needs: POST answers 202 with a Location header immediately, the
// job rides an SQS queue to the worker, and the finished artifact is handed
// back as a short-lived presigned S3 URL. This Lambda never does the export
// work itself; it only accepts, records, and reports.
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ddb } from '../lib/ddb.js';
import { errorJson, json, notFound, route } from '../lib/http.js';

const TABLE = process.env.TABLE_NAME!;
const QUEUE_URL = process.env.QUEUE_URL!;
const BUCKET = process.env.BUCKET!;
const EXPORTS_PER_DAY = Number(process.env.EXPORTS_PER_DAY!);
const DOWNLOAD_TTL_SECONDS = 900;

const sqs = new SQSClient({});
const s3 = new S3Client({});

interface JobItem extends Record<string, unknown> {
  id: string;
  status: string;
  format: string;
}

function publicJob(item: JobItem): Record<string, unknown> {
  const { ttl, ...rest } = item;
  return rest;
}

// Global daily cap on job creation, taken atomically. Counter rows live in
// the jobs table under a CNT# id the EXP- guard below keeps unreadable.
async function takeExportSlot(): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { id: `CNT#${new Date().toISOString().slice(0, 10)}` },
        UpdateExpression: 'ADD n :one SET #ttl = if_not_exists(#ttl, :ttl)',
        ConditionExpression: 'attribute_not_exists(n) OR n < :cap',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':one': 1,
          ':cap': EXPORTS_PER_DAY,
          ':ttl': Math.floor(Date.now() / 1000) + 48 * 3600,
        },
      })
    );
    return true;
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

export const handler = route({
  // Body already gateway-validated against the ExportRequest model.
  'POST /v2/exports': async (event) => {
    const { service, format } = JSON.parse(event.body!) as { service: string; format: string };
    if (!(await takeExportSlot())) {
      return errorJson(429, 'export_limit', 'The exchange has run its full allotment of exports for today. The counter resets at midnight UTC.');
    }

    const now = new Date();
    const id = `EXP-${now.getTime().toString(36).toUpperCase()}${Math.floor(Math.random() * 1296)
      .toString(36)
      .toUpperCase()
      .padStart(2, '0')}`;
    const job: JobItem = {
      id,
      service,
      format,
      status: 'queued',
      requestedAt: now.toISOString(),
      ttl: Math.floor(now.getTime() / 1000) + 24 * 3600,
    };
    await ddb.send(new PutCommand({ TableName: TABLE, Item: job }));
    await sqs.send(new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: JSON.stringify({ id }) }));

    return json(202, { data: publicJob(job) }, { location: `/v2/exports/${id}` });
  },

  'GET /v2/exports/{id}': async (event) => {
    const id = event.pathParameters!.id!;
    // Job ids all carry the EXP- prefix; anything else (like the CNT# counter
    // rows sharing this table) is not addressable.
    if (!id.startsWith('EXP-')) return notFound(`Export ${id}`);
    const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { id } }));
    if (!res.Item) return notFound(`Export ${id}`);
    const job = publicJob(res.Item as JobItem);

    if (res.Item.status === 'done' && res.Item.objectKey) {
      // Presigned GET: the bucket stays fully private; the URL itself is the
      // capability, and it dies after 15 minutes.
      job.downloadUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: BUCKET,
          Key: res.Item.objectKey as string,
          ResponseContentDisposition: `attachment; filename="alpenglow-${res.Item.service}-export.${res.Item.format}"`,
        }),
        { expiresIn: DOWNLOAD_TTL_SECONDS }
      );
      job.downloadExpiresSeconds = DOWNLOAD_TTL_SECONDS;
    }
    return json(200, { data: job });
  },
});
