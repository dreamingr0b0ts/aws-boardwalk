import { QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE, publicView } from '../lib/db.js';
import { router, json, pathParam, HttpError } from '../lib/http.js';

export const handler = router({
  'GET /api/public/permit-types': async () => {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        FilterExpression: '#a = :true',
        ExpressionAttributeNames: { '#a': 'active' },
        ExpressionAttributeValues: { ':pk': 'CATALOG', ':sk': 'TYPE#', ':true': true },
      })
    );
    const types = (res.Items ?? []).map(publicView).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return json(200, { types });
  },

  'GET /api/public/stats': async () => {
    const [current, monthly] = await Promise.all([
      ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: 'STATS', SK: 'CURRENT' } })),
      ddb.send(
        new QueryCommand({
          TableName: TABLE,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: { ':pk': 'STATS', ':sk': 'MONTH#' },
        })
      ),
    ]);
    return json(200, {
      current: current.Item ? publicView(current.Item) : null,
      monthly: (monthly.Items ?? []).map(publicView),
    });
  },

  /**
   * Field verification: the QR code on a printed permit certificate resolves
   * here. Permits are public record, so this needs no sign-in — but it only
   * discloses the register line, never the application narrative. Lookup is
   * by exact unguessable id.
   */
  'GET /api/public/verify/{id}': async (event) => {
    const id = pathParam(event, 'id').toUpperCase();
    if (!/^APP-[A-Z0-9]{4,20}$/.test(id)) throw new HttpError(400, 'Malformed permit number');

    const meta = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `APP#${id}`, SK: 'META' } }));
    if (!meta.Item) throw new HttpError(404, 'No permit with that number is on file');

    const a = meta.Item;
    return json(200, {
      record: {
        id: a.id,
        typeName: a.typeName,
        category: a.category,
        address: a.address,
        holder: a.applicantName,
        status: a.status,
        submittedAt: a.submittedAt,
        decidedAt: a.decidedAt ?? null,
      },
      checkedAt: new Date().toISOString(),
    });
  },
});
