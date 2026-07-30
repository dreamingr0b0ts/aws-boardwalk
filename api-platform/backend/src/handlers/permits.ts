// Permits microservice — owns the apx-permits table and nothing else.
// Serves both API versions from one codebase so the version split is an
// interface-governance story, not a fork: v1 returns bare arrays with
// Deprecation/Sunset headers, v2 returns the paginated envelope and accepts
// inspection requests (whose body API Gateway has already schema-validated
// before this code runs).
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, listScan } from '../lib/ddb.js';
import { BadRequest, cachedJson, envelope, errorJson, header, json, notFound, pageLimit, route, v1Json } from '../lib/http.js';

const TABLE = process.env.TABLE_NAME!;
const KEY_ATTRS = ['PK', 'SK'];

const PERMIT_TYPES = ['building', 'electrical', 'plumbing', 'mechanical', 'sign', 'fence', 'solar', 'event'];
const PERMIT_STATUSES = ['submitted', 'under-review', 'approved', 'issued', 'denied', 'closed'];

interface PermitItem extends Record<string, unknown> {
  PK: string;
  SK: string;
}

function publicView(item: PermitItem): Record<string, unknown> {
  const { PK, SK, ttl, ...rest } = item;
  return rest;
}

function validateFilter(name: string, value: string | undefined, allowed: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value)) {
    throw new BadRequest(`${name} must be one of: ${allowed.join(', ')}.`);
  }
  return value;
}

async function getPermit(id: string): Promise<PermitItem | undefined> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: id, SK: 'META' } }));
  return res.Item as PermitItem | undefined;
}

async function listPermits(event: APIGatewayProxyEvent) {
  const q = event.queryStringParameters ?? {};
  return listScan({
    table: TABLE,
    keyAttrs: KEY_ATTRS,
    limit: pageLimit(event),
    nextToken: q.nextToken,
    equals: {
      SK: 'META',
      type: validateFilter('type', q.type, PERMIT_TYPES),
      status: validateFilter('status', q.status, PERMIT_STATUSES),
    },
  });
}

export const handler = route({
  // ---- v1 (deprecated, still served) ----
  'GET /v1/permits': async (event) => {
    const page = await listPermits(event);
    return v1Json(200, page.items.map((i) => publicView(i as PermitItem)), '/v2/permits');
  },
  'GET /v1/permits/{id}': async (event) => {
    const id = event.pathParameters!.id!;
    const item = await getPermit(id);
    if (!item) return notFound(`Permit ${id}`);
    return v1Json(200, publicView(item), `/v2/permits/${id}`);
  },

  // ---- v2 ----
  'GET /v2/permits': async (event) => {
    const page = await listPermits(event);
    return json(200, envelope(page.items.map((i) => publicView(i as PermitItem)), page.lastEvaluatedKey));
  },
  'GET /v2/permits/{id}': async (event) => {
    const id = event.pathParameters!.id!;
    const item = await getPermit(id);
    if (!item) return notFound(`Permit ${id}`);
    return cachedJson(event, { data: publicView(item) });
  },

  'GET /v2/permits/{id}/inspections': async (event) => {
    const id = event.pathParameters!.id!;
    if (!(await getPermit(id))) return notFound(`Permit ${id}`);
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :ins)',
        ExpressionAttributeValues: { ':pk': id, ':ins': 'INS#' },
      })
    );
    const items = (res.Items ?? []).map((i) => publicView(i as PermitItem));
    return json(200, envelope(items));
  },

  // API Gateway's request validator has already enforced the InspectionRequest
  // model (required fields, enums, formats, no extra properties) — a
  // malformed body never reaches this code. Only cross-record rules live here.
  'POST /v2/permits/{id}/inspections': async (event) => {
    const id = event.pathParameters!.id!;
    const permit = await getPermit(id);
    if (!permit) return notFound(`Permit ${id}`);
    if (permit.status !== 'issued' && permit.status !== 'approved') {
      return errorJson(409, 'not_inspectable', `Permit ${id} is ${permit.status}; inspections can only be requested for approved or issued permits.`);
    }

    // Idempotency-Key: reserve the key with a conditional write, so a retry
    // (client timeout, double-click, at-least-once queue) replays the original
    // 201 instead of creating a duplicate. Reservation happens after the
    // business checks above so a rejected request never burns a key. Records
    // share the visitor-write 24h TTL.
    const idemKey = header(event, 'idempotency-key');
    if (idemKey !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(idemKey)) {
      return errorJson(400, 'bad_request', 'Idempotency-Key must be 1-64 characters of letters, digits, underscore, or hyphen.');
    }
    if (idemKey) {
      try {
        await ddb.send(
          new PutCommand({
            TableName: TABLE,
            Item: { PK: id, SK: `IDEM#${idemKey}`, state: 'in-progress', ttl: Math.floor(Date.now() / 1000) + 24 * 3600 },
            ConditionExpression: 'attribute_not_exists(PK)',
          })
        );
      } catch (err) {
        if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
        const saved = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: id, SK: `IDEM#${idemKey}` } }));
        const stored = saved.Item?.response as string | undefined;
        if (stored) {
          return json(201, JSON.parse(stored), {
            'idempotency-replayed': 'true',
            location: `/v2/permits/${id}/inspections`,
          });
        }
        return errorJson(409, 'idempotency_in_progress', 'The original request with this Idempotency-Key is still being processed. Retry in a moment.');
      }
    }

    const body = JSON.parse(event.body!) as {
      type: string;
      preferredDate: string;
      contactEmail: string;
      notes?: string;
    };
    const now = new Date();
    const inspectionId = `INSP-${now.getTime().toString(36).toUpperCase()}${Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0')}`;
    const item = {
      PK: id,
      SK: `INS#${inspectionId}`,
      id: inspectionId,
      permitId: id,
      type: body.type,
      preferredDate: body.preferredDate,
      contactEmail: body.contactEmail,
      notes: body.notes,
      status: 'requested',
      requestedAt: now.toISOString(),
      // Visitor-created records self-clean after 24h; the seed catalog has no ttl.
      ttl: Math.floor(now.getTime() / 1000) + 24 * 3600,
    };
    await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
    const response = { data: publicView(item) };
    if (idemKey) {
      // Overwrite the reservation with the response to replay. If this write
      // fails the reservation TTLs out in 24h — replays 409 until then, which
      // is the honest answer when we can't prove what the original returned.
      await ddb.send(
        new PutCommand({
          TableName: TABLE,
          Item: { PK: id, SK: `IDEM#${idemKey}`, state: 'completed', response: JSON.stringify(response), ttl: item.ttl },
        })
      );
    }
    return json(201, response, { location: `/v2/permits/${id}/inspections` });
  },
});
