import { createHash } from 'node:crypto';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { router, json, parseBody, HttpError, type ApiEvent } from '../lib/http';
import { runAndFetch, quoteParam, type QueryResult } from '../lib/athena';
import { catalog, catalogById, searchSql } from '../lib/queries';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const BUCKET = process.env.LAKE_BUCKET!;
const ANALYTICS_PREFIX = process.env.ANALYTICS_PREFIX!;
const TABLE = process.env.TABLE_NAME!;
const DAILY_LIMIT = Number(process.env.GLOBAL_DAILY_LIMIT ?? 150);
const SEARCH_IP_LIMIT = Number(process.env.SEARCH_IP_DAILY_LIMIT ?? 30);
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
      throw new HttpError(429, `Daily live-query budget (${DAILY_LIMIT} Athena executions) is spent. Cached results still work; fresh runs resume at 00:00 UTC.`);
    }
    throw err;
  }
}

/** The viewer's IP is the second-from-last X-Forwarded-For entry: CloudFront
    appends the true viewer IP and API Gateway appends CloudFront's, so a
    client-sent XFF header can't spoof it through CloudFront (fmw pattern). */
function visitorHash(event: ApiEvent): string {
  const parts = (event.headers?.['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const ip = parts.length >= 2 ? parts[parts.length - 2] : (parts[0] ?? event.requestContext?.http?.sourceIp ?? 'unknown');
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

/** Per-IP slice of the search budget, same conditional-ADD shape as the
    global counter. Keeps one visitor from drinking the whole day. */
async function takeSearchSlot(event: ApiEvent): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `SEARCH#${today()}`, SK: `IP#${visitorHash(event)}` },
        UpdateExpression: 'ADD n :one SET #ttl = if_not_exists(#ttl, :ttl)',
        ConditionExpression: 'attribute_not_exists(n) OR n < :limit',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':one': 1,
          ':limit': SEARCH_IP_LIMIT,
          ':ttl': Math.floor(Date.now() / 1000) + 3 * 86400,
        },
      })
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw new HttpError(429, `That's ${SEARCH_IP_LIMIT} searches today from your address; the lake reopens at 00:00 UTC.`);
    }
    throw err;
  }
}

const getSummary = async () => {
  const names = ['manifest', 'formations_by_year', 'entity_types', 'status_breakdown', 'top_cities', 'cohort_survival', 'map_zips'];
  const [use, ...files] = await Promise.all([usage(), ...names.map((n) => getJson(`${ANALYTICS_PREFIX}/${n}.json`))]);
  const body = Object.fromEntries(names.map((n, i) => [n, files[i]]));
  if (!body.manifest) throw new HttpError(503, 'The lake has not been built yet: the ETL has not published a manifest.');
  return json(200, { ...body, usage: use });
};

const getQueries = async () => json(200, { queries: catalog, maxRows: MAX_ROWS });

const postQuery = async (event: ApiEvent) => {
  const { id } = parseBody<{ id?: string }>(event);
  const entry = id ? catalogById.get(id) : undefined;
  if (!entry) throw new HttpError(400, `Unknown query id. Expected one of: ${catalog.map((q) => q.id).join(', ')}`);

  const cacheKey = { PK: `CACHE#${entry.id}`, SK: 'RESULT' };
  const cached = await ddb.send(new GetCommand({ TableName: TABLE, Key: cacheKey }));
  if (cached.Item && Number(cached.Item.ttl) > Date.now() / 1000) {
    const result = JSON.parse(cached.Item.payload as string) as QueryResult & { executedAt: string };
    return json(200, { id: entry.id, zone: entry.zone, decades: entry.decades ?? null, ...result, cached: true, usage: await usage() });
  }

  await takeUsageSlot();
  let result: QueryResult;
  try {
    result = await runAndFetch(entry.sql, MAX_ROWS, { withRuntime: true });
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
  return json(200, { id: entry.id, zone: entry.zone, decades: entry.decades ?? null, ...payload, cached: false, usage: await usage() });
};

// The name lookup. Visitor text is normalized, allowlisted, and bound to the
// SQL's `?` as an Athena execution parameter — it is never spliced into the
// query string. Athena parses each parameter as one expression in the
// placeholder position (verified live: a "'x' OR '1'='1'" value fails with
// TYPE_MISMATCH rather than widening the WHERE), and the allowlist plus
// quoteParam keep the bound value a plain varchar literal anyway.
const SEARCH_CHARSET = /^[A-Z0-9 &.,'()#/+-]+$/;

const postSearch = async (event: ApiEvent) => {
  const { q } = parseBody<{ q?: string }>(event);
  const term = (q ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (term.length < 2 || term.length > 40) {
    throw new HttpError(400, 'Give me 2 to 40 characters of a business name to look for.');
  }
  if (!SEARCH_CHARSET.test(term) || !/[A-Z0-9]/.test(term)) {
    throw new HttpError(400, "Names here use letters, digits, spaces, and &.,'()#/+- only.");
  }

  const cacheKey = { PK: `CACHE#search:${term}`, SK: 'RESULT' };
  const cached = await ddb.send(new GetCommand({ TableName: TABLE, Key: cacheKey }));
  if (cached.Item && Number(cached.Item.ttl) > Date.now() / 1000) {
    const result = JSON.parse(cached.Item.payload as string) as QueryResult & { executedAt: string; totalMatches: number };
    return json(200, { q: term, ...result, cached: true, usage: await usage() });
  }

  await takeSearchSlot(event);
  await takeUsageSlot();
  let result: QueryResult;
  try {
    result = await runAndFetch(searchSql, 25, { withRuntime: true, params: [quoteParam(`${term}%`)] });
  } catch (err) {
    throw new HttpError(502, `Athena: ${err instanceof Error ? err.message : 'query failed'}`);
  }

  // total_matches is a window value repeated on every row — lift it out.
  const totalIdx = result.columns.indexOf('total_matches');
  const totalMatches = totalIdx >= 0 ? Number(result.rows[0]?.[totalIdx] ?? 0) : result.rows.length;
  const columns = result.columns.filter((_, i) => i !== totalIdx);
  const rows = result.rows.map((r) => r.filter((_, i) => i !== totalIdx));

  const payload = { ...result, columns, rows, totalMatches, executedAt: new Date().toISOString() };
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { ...cacheKey, payload: JSON.stringify(payload), ttl: Math.floor(Date.now() / 1000) + CACHE_TTL_S },
    })
  );
  return json(200, { q: term, ...payload, cached: false, usage: await usage() });
};

export const handler = router({
  'GET /api/summary': getSummary,
  'GET /api/queries': getQueries,
  'POST /api/query': postQuery,
  'POST /api/search': postSearch,
});
