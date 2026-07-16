// The trace store every hop writes into. One item per hop, keyed so a single
// Query returns a request's whole journey in order:
//   REQ#<id> / META                  the request record
//   REQ#<id> / HOP#<iso-ts>#<name>   one hop through the mesh
//   STATS    / TOTALS                lifetime counters for the hero stats

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

const TABLE = process.env.TABLE_NAME!;

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const TTL_HOURS = 48;
export const ttl = () => Math.floor(Date.now() / 1000) + TTL_HOURS * 3600;

/** Human-facing id shown in the feed, e.g. REQ-3F9A. */
export const shortId = (requestId: string) =>
  `REQ-${requestId.replace(/-/g, '').slice(0, 4).toUpperCase()}`;

export interface RequestDetail {
  requestId: string;
  category: string;
  priority: string;
  description: string;
  simulate: string;
  origin: string;
}

export interface Hop {
  hop: string;
  at: string;
  note?: string;
  actor?: string;
}

/**
 * Create the META record if it doesn't exist yet. Idempotent on purpose —
 * heartbeat events never pass through the API, so whichever consumer touches
 * a request first materializes it.
 */
export async function ensureMeta(detail: RequestDetail): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `REQ#${detail.requestId}`, SK: 'META' },
      UpdateExpression:
        'SET shortId = if_not_exists(shortId, :sid), category = if_not_exists(category, :c), ' +
        'priority = if_not_exists(priority, :p), description = if_not_exists(description, :d), ' +
        'simulate = if_not_exists(simulate, :sim), origin = if_not_exists(origin, :o), ' +
        '#s = if_not_exists(#s, :submitted), createdAt = if_not_exists(createdAt, :now), ' +
        'lastActivity = :now, #t = if_not_exists(#t, :ttl)',
      ExpressionAttributeNames: { '#s': 'status', '#t': 'ttl' },
      ExpressionAttributeValues: {
        ':sid': shortId(detail.requestId),
        ':c': detail.category,
        ':p': detail.priority,
        ':d': detail.description,
        ':sim': detail.simulate ?? 'none',
        ':o': detail.origin ?? 'visitor',
        ':submitted': 'submitted',
        ':now': new Date().toISOString(),
        ':ttl': ttl(),
      },
    })
  );
}

export async function addHop(
  requestId: string,
  hop: string,
  note?: string,
  actor?: string
): Promise<void> {
  const at = new Date().toISOString();
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: `REQ#${requestId}`, SK: `HOP#${at}#${hop}`, hop, at, note, actor, ttl: ttl() },
    })
  );
}

export async function setMeta(requestId: string, field: string, value: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `REQ#${requestId}`, SK: 'META' },
      UpdateExpression: 'SET #f = :v, lastActivity = :now',
      ExpressionAttributeNames: { '#f': field },
      ExpressionAttributeValues: { ':v': value, ':now': new Date().toISOString() },
    })
  );
}

/** Lifetime counters behind the hero stats. */
export async function bumpStats(names: string[]): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: 'STATS', SK: 'TOTALS' },
      UpdateExpression: `ADD ${names.map((_, i) => `#n${i} :one`).join(', ')}`,
      ExpressionAttributeNames: Object.fromEntries(names.map((n, i) => [`#n${i}`, n])),
      ExpressionAttributeValues: { ':one': 1 },
    })
  );
}

export interface Trace {
  meta: Record<string, unknown> | undefined;
  hops: Hop[];
}

export async function getTrace(requestId: string): Promise<Trace> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `REQ#${requestId}` },
    })
  );
  const items = res.Items ?? [];
  return {
    meta: items.find((i) => i.SK === 'META'),
    // HOP#<iso-ts># sort keys are already chronological
    hops: items
      .filter((i) => typeof i.SK === 'string' && i.SK.startsWith('HOP#'))
      .map((i) => ({ hop: i.hop, at: i.at, note: i.note, actor: i.actor })),
  };
}
