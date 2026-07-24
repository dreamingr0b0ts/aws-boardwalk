import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { ddb, TABLE, publicView, type PermitType } from '../lib/db.js';
import { router, json, claims, parseBody, pathParam, requireString, HttpError } from '../lib/http.js';
import {
  ALLOWED_CONTENT_TYPES,
  GLOBAL_ATTACHMENTS_PER_DAY,
  MAX_ATTACHMENTS_PER_APP,
  MAX_ATTACHMENT_BYTES,
  attachmentKey,
  presignDownload,
  presignUpload,
  uploadedSize,
} from '../lib/uploads.js';

interface NewApplication {
  typeSlug: string;
  address: string;
  description: string;
}

/** Load an application's META row, 404ing unless the caller owns it. */
async function ownApplication(event: Parameters<typeof claims>[0], id: string) {
  const who = claims(event);
  const meta = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `APP#${id}`, SK: 'META' } }));
  // 404 (not 403) for other people's applications — don't leak existence.
  if (!meta.Item || meta.Item.applicantSub !== who.sub) throw new HttpError(404, 'Application not found');
  return { who, app: meta.Item };
}

async function listAttachments(id: string) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `APP#${id}`, ':sk': 'ATT#' },
    })
  );
  return (res.Items ?? []).filter((a) => a.status === 'uploaded');
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
    const id = pathParam(event, 'id');
    const { app } = await ownApplication(event, id);

    const events = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `APP#${id}`, ':sk': 'EVENT#' },
      })
    );

    return json(200, {
      application: publicView(app),
      events: (events.Items ?? []).map(publicView),
    });
  },

  // --- attachments ---------------------------------------------------------

  'GET /api/me/applications/{id}/attachments': async (event) => {
    const id = pathParam(event, 'id');
    await ownApplication(event, id);
    const items = await listAttachments(id);
    const attachments = await Promise.all(
      items.map(async (a) => ({
        ...publicView(a),
        downloadUrl: await presignDownload(String(a.s3Key), String(a.filename)),
      }))
    );
    return json(200, { attachments });
  },

  'POST /api/me/applications/{id}/attachments': async (event) => {
    const id = pathParam(event, 'id');
    const { who, app } = await ownApplication(event, id);
    if (app.status !== 'submitted' && app.status !== 'under_review') {
      throw new HttpError(409, 'Documents can only be added while the application is open');
    }

    const body = parseBody<{ filename: string; contentType: string }>(event);
    const filename = requireString(body.filename, 'filename', 1, 120);
    const contentType = requireString(body.contentType, 'contentType', 1, 80);
    if (!ALLOWED_CONTENT_TYPES[contentType]) {
      throw new HttpError(400, 'Accepted document types: PDF, PNG, JPEG');
    }

    const existing = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `APP#${id}`, ':sk': 'ATT#' },
        Select: 'COUNT',
      })
    );
    if ((existing.Count ?? 0) >= MAX_ATTACHMENTS_PER_APP) {
      throw new HttpError(409, `Limit of ${MAX_ATTACHMENTS_PER_APP} documents per application`);
    }

    // Portfolio-wide guardrail pattern: a global daily ceiling bounds worst-case
    // spend even if every visitor uploads at once.
    const day = new Date().toISOString().slice(0, 10);
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { PK: 'COUNTER', SK: `ATT#${day}` },
          UpdateExpression: 'ADD #n :one',
          ConditionExpression: 'attribute_not_exists(#n) OR #n < :cap',
          ExpressionAttributeNames: { '#n': 'n' },
          ExpressionAttributeValues: { ':one': 1, ':cap': GLOBAL_ATTACHMENTS_PER_DAY },
        })
      );
    } catch {
      throw new HttpError(429, 'The demo has reached its document limit for today. It resets nightly.');
    }

    const attId = randomUUID().slice(0, 8);
    const s3Key = attachmentKey(id, attId);
    const upload = await presignUpload(s3Key, contentType);

    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `APP#${id}`,
          SK: `ATT#${attId}`,
          entity: 'Attachment',
          attId,
          filename,
          contentType,
          status: 'pending',
          requestedAt: new Date().toISOString(),
          requestedBy: who.email,
          s3Key,
        },
      })
    );

    return json(201, { attachmentId: attId, maxBytes: MAX_ATTACHMENT_BYTES, upload });
  },

  'POST /api/me/applications/{id}/attachments/{attId}/confirm': async (event) => {
    const id = pathParam(event, 'id');
    const attId = pathParam(event, 'attId');
    const { who, app } = await ownApplication(event, id);

    const att = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `APP#${id}`, SK: `ATT#${attId}` } }));
    if (!att.Item) throw new HttpError(404, 'Attachment not found');
    if (att.Item.status === 'uploaded') return json(200, { attachmentId: attId, status: 'uploaded' });

    const size = await uploadedSize(String(att.Item.s3Key));
    if (size === null) throw new HttpError(409, 'Upload not received yet');

    const now = new Date().toISOString();
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: { PK: `APP#${id}`, SK: `ATT#${attId}` },
              UpdateExpression: 'SET #s = :up, #sz = :size, uploadedAt = :now',
              ExpressionAttributeNames: { '#s': 'status', '#sz': 'size' },
              ExpressionAttributeValues: { ':up': 'uploaded', ':size': size, ':now': now },
            },
          },
          {
            // The clerk logs the receipt in the record of actions.
            Put: {
              TableName: TABLE,
              Item: {
                PK: `APP#${id}`,
                SK: `EVENT#${now}#0`,
                entity: 'Event',
                status: app.status,
                at: now,
                actor: who.email,
                note: `Document received: ${att.Item.filename}`,
              },
            },
          },
        ],
      })
    );

    return json(200, { attachmentId: attId, status: 'uploaded', size });
  },

  // --- notifications -------------------------------------------------------

  'GET /api/me/notifications': async (event) => {
    const who = claims(event);
    const [notifs, profile] = await Promise.all([
      ddb.send(
        new QueryCommand({
          TableName: TABLE,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: { ':pk': `USER#${who.sub}`, ':sk': 'NOTIF#' },
          ScanIndexForward: false,
          Limit: 20,
        })
      ),
      ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `USER#${who.sub}`, SK: 'PROFILE' } })),
    ]);
    return json(200, {
      notifications: (notifs.Items ?? []).map(publicView),
      lastReadAt: profile.Item?.lastReadAt ?? null,
    });
  },

  'POST /api/me/notifications/read': async (event) => {
    const who = claims(event);
    const now = new Date().toISOString();
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `USER#${who.sub}`, SK: 'PROFILE' },
        UpdateExpression: 'SET lastReadAt = :now, entity = :e',
        ExpressionAttributeValues: { ':now': now, ':e': 'Profile' },
      })
    );
    return json(200, { lastReadAt: now });
  },
});
