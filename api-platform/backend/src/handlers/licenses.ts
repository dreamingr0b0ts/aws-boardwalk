// Business-licenses microservice — owns the apx-licenses table and nothing else.
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, listScan } from '../lib/ddb.js';
import { BadRequest, envelope, json, notFound, pageLimit, route, v1Json } from '../lib/http.js';

const TABLE = process.env.TABLE_NAME!;
const KEY_ATTRS = ['id'];

const CATEGORIES = ['food-service', 'retail', 'contractor', 'childcare', 'liquor', 'lodging', 'mobile-vendor'];
const STATUSES = ['active', 'expired', 'suspended'];

function validateFilter(name: string, value: string | undefined, allowed: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value)) {
    throw new BadRequest(`${name} must be one of: ${allowed.join(', ')}.`);
  }
  return value;
}

async function listLicenses(event: APIGatewayProxyEvent) {
  const q = event.queryStringParameters ?? {};
  return listScan({
    table: TABLE,
    keyAttrs: KEY_ATTRS,
    limit: pageLimit(event),
    nextToken: q.nextToken,
    equals: {
      category: validateFilter('category', q.category, CATEGORIES),
      status: validateFilter('status', q.status, STATUSES),
    },
  });
}

export const handler = route({
  // ---- v1 (deprecated, still served) ----
  'GET /v1/licenses': async (event) => {
    const page = await listLicenses(event);
    return v1Json(200, page.items, '/v2/licenses');
  },

  // ---- v2 ----
  'GET /v2/licenses': async (event) => {
    const page = await listLicenses(event);
    return json(200, envelope(page.items, page.lastEvaluatedKey));
  },
  'GET /v2/licenses/{id}': async (event) => {
    const id = event.pathParameters!.id!;
    const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { id } }));
    if (!res.Item) return notFound(`License ${id}`);
    return json(200, { data: res.Item });
  },
});
