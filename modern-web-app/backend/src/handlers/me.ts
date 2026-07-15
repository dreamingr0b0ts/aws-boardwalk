import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE, publicView, type PermitType } from '../lib/db.js';
import { router, json, claims, parseBody, pathParam, requireString, HttpError } from '../lib/http.js';

interface NewApplication {
  typeSlug: string;
  address: string;
  description: string;
}

export const handler = router({
  'GET /api/me/applications': async (event) => {
    const who = claims(event);
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': `USER#${who.sub}` },
        ScanIndexForward: false,
      })
    );
    return json(200, { applications: (res.Items ?? []).map(publicView) });
  },

  'POST /api/me/applications': async (event) => {
    const who = claims(event);
    const body = parseBody<NewApplication>(event);
    const typeSlug = requireString(body.typeSlug, 'typeSlug', 1, 64);
    const address = requireString(body.address, 'address', 5, 200);
    const description = requireString(body.description, 'description', 10, 2000);

    const typeRes = await ddb.send(
      new GetCommand({ TableName: TABLE, Key: { PK: 'CATALOG', SK: `TYPE#${typeSlug}` } })
    );
    const type = typeRes.Item as (PermitType & { active: boolean }) | undefined;
    if (!type || !type.active) throw new HttpError(400, 'Unknown or inactive permit type');

    const now = new Date();
    const submittedAt = now.toISOString();
    const id = `APP-${now.getTime().toString(36).toUpperCase()}${Math.floor(Math.random() * 1296)
      .toString(36)
      .toUpperCase()
      .padStart(2, '0')}`;

    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE,
              ConditionExpression: 'attribute_not_exists(PK)',
              Item: {
                PK: `APP#${id}`,
                SK: 'META',
                entity: 'Application',
                id,
                typeSlug,
                typeName: type.name,
                category: type.category,
                applicantSub: who.sub,
                applicantName: who.name,
                applicantEmail: who.email,
                address,
                description,
                status: 'submitted',
                submittedAt,
                GSI1PK: `USER#${who.sub}`,
                GSI1SK: submittedAt,
                GSI2PK: 'STATUS#submitted',
                GSI2SK: submittedAt,
              },
            },
          },
          {
            Put: {
              TableName: TABLE,
              Item: {
                PK: `APP#${id}`,
                SK: `EVENT#${submittedAt}#0`,
                entity: 'Event',
                status: 'submitted',
                at: submittedAt,
                actor: 'system',
                note: 'Application received',
              },
            },
          },
          {
            Update: {
              TableName: TABLE,
              Key: { PK: 'STATS', SK: 'CURRENT' },
              UpdateExpression: 'ADD #counts.#s :one, #total :one SET updatedAt = :now',
              ExpressionAttributeNames: { '#counts': 'counts', '#s': 'submitted', '#total': 'total' },
              ExpressionAttributeValues: { ':one': 1, ':now': submittedAt },
            },
          },
        ],
      })
    );

    return json(201, { id, status: 'submitted', submittedAt });
  },

  'GET /api/me/applications/{id}': async (event) => {
    const who = claims(event);
    const id = pathParam(event, 'id');

    const meta = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `APP#${id}`, SK: 'META' } }));
    // 404 (not 403) for other people's applications — don't leak existence.
    if (!meta.Item || meta.Item.applicantSub !== who.sub) throw new HttpError(404, 'Application not found');

    const events = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `APP#${id}`, ':sk': 'EVENT#' },
      })
    );

    return json(200, {
      application: publicView(meta.Item),
      events: (events.Items ?? []).map(publicView),
    });
  },
});
