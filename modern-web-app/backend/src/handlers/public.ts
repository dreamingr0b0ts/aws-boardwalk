import { QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE, publicView } from '../lib/db.js';
import { router, json } from '../lib/http.js';

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
});
