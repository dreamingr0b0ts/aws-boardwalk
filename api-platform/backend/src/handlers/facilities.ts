// Facilities microservice — owns the apx-facilities table and nothing else.
// v2-only on purpose: it launched after the v1 deprecation, so there is no
// legacy surface to carry.
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, listScan } from '../lib/ddb.js';
import { BadRequest, envelope, json, notFound, pageLimit, route } from '../lib/http.js';

const TABLE = process.env.TABLE_NAME!;
const KEY_ATTRS = ['id'];

const KINDS = ['park', 'trail', 'rec-center', 'library', 'pool', 'sports-field'];

async function getFacility(id: string) {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { id } }));
  return res.Item;
}

export const handler = route({
  'GET /v2/facilities': async (event: APIGatewayProxyEvent) => {
    const q = event.queryStringParameters ?? {};
    const kind = q.kind;
    if (kind !== undefined && !KINDS.includes(kind)) {
      throw new BadRequest(`kind must be one of: ${KINDS.join(', ')}.`);
    }
    const page = await listScan({
      table: TABLE,
      keyAttrs: KEY_ATTRS,
      limit: pageLimit(event),
      nextToken: q.nextToken,
      equals: { kind },
    });
    // Listing view stays lightweight; hours live on the dedicated sub-resource.
    const items = page.items.map(({ hours, ...rest }) => rest);
    return json(200, envelope(items, page.lastEvaluatedKey));
  },

  'GET /v2/facilities/{id}': async (event) => {
    const id = event.pathParameters!.id!;
    const item = await getFacility(id);
    if (!item) return notFound(`Facility ${id}`);
    const { hours, ...rest } = item;
    return json(200, { data: rest });
  },

  'GET /v2/facilities/{id}/hours': async (event) => {
    const id = event.pathParameters!.id!;
    const item = await getFacility(id);
    if (!item) return notFound(`Facility ${id}`);
    return json(200, { data: { facilityId: id, name: item.name, hours: item.hours, seasonalNote: item.seasonalNote } });
  },
});
