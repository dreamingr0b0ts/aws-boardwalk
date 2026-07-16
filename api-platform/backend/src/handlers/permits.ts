// Permits microservice — owns the apx-permits table and nothing else.
// Serves both API versions from one codebase so the version split is an
// interface-governance story, not a fork: v1 returns bare arrays with
// Deprecation/Sunset headers, v2 returns the paginated envelope and accepts
// inspection requests (whose body API Gateway has already schema-validated
// before this code runs).
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, listScan } from '../lib/ddb.js';
import { BadRequest, envelope, errorJson, json, notFound, pageLimit, route, v1Json } from '../lib/http.js';

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
    return json(200, { data: publicView(item) });
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
    return json(201, { data: publicView(item) }, { location: `/v2/permits/${id}/inspections` });
  },
});
