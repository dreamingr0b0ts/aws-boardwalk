import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { router, json, parseBody, HttpError, type ApiEvent } from '../lib/http';
import { runAndFetch, type QueryResult } from '../lib/athena';
import { catalog, catalogById } from '../lib/queries';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const BUCKET = process.env.LAKE_BUCKET!;
const ANALYTICS_PREFIX = process.env.ANALYTICS_PREFIX!;
const TABLE = process.env.TABLE_NAME!;
const DAILY_LIMIT = Number(process.env.GLOBAL_DAILY_LIMIT ?? 150);
const CACHE_TTL_S = Number(process.env.CACHE_TTL_HOURS ?? 6) * 3600;
const MAX_ROWS = 50;

const today = () => new Date().toISOString().slice(0, 10);

async function getJson(key: string): Promise<unknown | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return JSON.parse(await res.Body!.transformToString());
  } catch {
    return null;
  }
}

async function usage(): Promise<{ used: number; limit: number }> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `USAGE#${today()}`, SK: 'GLOBAL' } }));
  return { used: Number(res.Item?.n ?? 0), limit: DAILY_LIMIT };
}

/** One atomic slot of the daily Athena budget; 429 when the day is spent. */
async function takeUsageSlot(): Promise<number> {
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `USAGE#${today()}`, SK: 'GLOBAL' },
        UpdateExpression: 'ADD n :one SET #ttl = if_not_exists(#ttl, :ttl)',
        ConditionExpression: 'attribute_not_exists(n) OR n < :limit',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':one': 1,
          ':limit': DAILY_LIMIT,
          ':ttl': Math.floor(Date.now() / 1000) + 3 * 86400,
        },
        ReturnValues: 'UPDATED_NEW',
      })
    );
    return Number(res.Attributes?.n ?? 0);
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw new HttpError(429, `Daily live-query budget (${DAILY_LIMIT} Athena executions) is spent — cached results still work, fresh runs resume at 00:00 UTC.`);
    }
    throw err;
  }
}

const getSummary = async () => {
  const names = ['manifest', 'formations_by_year', 'entity_types', 'status_breakdown', 'top_cities', 'cohort_survival'];
  const [use, ...files] = await Promise.all([usage(), ...names.map((n) => getJson(`${ANALYTICS_PREFIX}/${n}.json`))]);
  const body = Object.fromEntries(names.map((n, i) => [n, files[i]]));
  if (!body.manifest) throw new HttpError(503, 'The lake has not been built yet — the ETL has not published a manifest.');
  return json(200, { ...body, usage: use });
};

const getQueries = async () => json(200, { queries: catalog, maxRows: MAX_ROWS });

const postQuery = async (event: ApiEvent) => {
  const { id } = parseBody<{ id?: string }>(event);
  const entry = id ? catalogById.get(id) : undefined;
  if (!entry) throw new HttpError(400, `Unknown query id — expected one of: ${catalog.map((q) => q.id).join(', ')}`);

  const cacheKey = { PK: `CACHE#${entry.id}`, SK: 'RESULT' };
  const cached = await ddb.send(new GetCommand({ TableName: TABLE, Key: cacheKey }));
  if (cached.Item && Number(cached.Item.ttl) > Date.now() / 1000) {
    const result = JSON.parse(cached.Item.payload as string) as QueryResult & { executedAt: string };
    return json(200, { id: entry.id, zone: entry.zone, ...result, cached: true, usage: await usage() });
  }

  await takeUsageSlot();
  let result: QueryResult;
  try {
    result = await runAndFetch(entry.sql, MAX_ROWS);
  } catch (err) {
    throw new HttpError(502, `Athena: ${err instanceof Error ? err.message : 'query failed'}`);
  }

  const payload = { ...result, executedAt: new Date().toISOString() };
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { ...cacheKey, payload: JSON.stringify(payload), ttl: Math.floor(Date.now() / 1000) + CACHE_TTL_S },
    })
  );
  return json(200, { id: entry.id, zone: entry.zone, ...payload, cached: false, usage: await usage() });
};

export const handler = router({
  'GET /api/summary': getSummary,
  'GET /api/queries': getQueries,
  'POST /api/query': postQuery,
});
