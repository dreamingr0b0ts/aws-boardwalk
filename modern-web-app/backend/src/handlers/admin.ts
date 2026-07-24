import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE, publicView, STATUSES, type AppStatus } from '../lib/db.js';
import { router, json, requireAdmin, parseBody, pathParam, requireString, HttpError } from '../lib/http.js';
import { presignDownload } from '../lib/uploads.js';

type DecisionAction = 'start_review' | 'approve' | 'deny';

const TRANSITIONS: Record<DecisionAction, { from: AppStatus[]; to: AppStatus }> = {
  start_review: { from: ['submitted'], to: 'under_review' },
  approve: { from: ['submitted', 'under_review'], to: 'approved' },
  deny: { from: ['submitted', 'under_review'], to: 'denied' },
};

async function queryStatus(status: AppStatus) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': `STATUS#${status}` },
      ScanIndexForward: false,
      Limit: 200,
    })
  );
  return (res.Items ?? []).map(publicView);
}

export const handler = router({
  'GET /api/admin/applications': async (event) => {
    requireAdmin(event);
    const status = event.queryStringParameters?.status as AppStatus | undefined;

    if (status) {
      if (!STATUSES.includes(status)) throw new HttpError(400, 'Invalid status filter');
      return json(200, { applications: await queryStatus(status) });
    }

    const all = (await Promise.all(STATUSES.map(queryStatus))).flat();
    all.sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
    return json(200, { applications: all });
  },

  'POST /api/admin/applications/{id}/decision': async (event) => {
    const who = requireAdmin(event);
    const id = pathParam(event, 'id');
    const body = parseBody<{ action: DecisionAction; note?: string }>(event);

    const transition = TRANSITIONS[body.action];
    if (!transition) throw new HttpError(400, "Action must be one of: start_review, approve, deny");
    const note = body.note ? requireString(body.note, 'note', 1, 1000) : undefined;

    const meta = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `APP#${id}`, SK: 'META' } }));
    if (!meta.Item) throw new HttpError(404, 'Application not found');

    const current = meta.Item.status as AppStatus;
    if (!transition.from.includes(current)) {
      throw new HttpError(409, `Cannot ${body.action} an application in status '${current}'`);
    }

    const now = new Date().toISOString();
    const isFinal = transition.to === 'approved' || transition.to === 'denied';

    // Approval of an inspection-required type opens the inspection phase.
    let needsInspection = false;
    if (transition.to === 'approved') {
      const typeRes = await ddb.send(
        new GetCommand({ TableName: TABLE, Key: { PK: 'CATALOG', SK: `TYPE#${meta.Item.typeSlug}` } })
      );
      needsInspection = typeRes.Item?.requiresInspection === true;
    }

    let updateExpr = isFinal
      ? 'SET #status = :new, GSI2PK = :gsi, decidedAt = :now, decisionNote = :note'
      : 'SET #status = :new, GSI2PK = :gsi';
    if (needsInspection) updateExpr += ', inspection = :insp';
    const updateValues: Record<string, unknown> = {
      ':new': transition.to,
      ':gsi': `STATUS#${transition.to}`,
      ':old': current,
    };
    if (isFinal) {
      updateValues[':now'] = now;
      updateValues[':note'] = note ?? (transition.to === 'approved' ? 'Approved' : 'Denied');
    }
    if (needsInspection) updateValues[':insp'] = 'required';

    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: { PK: `APP#${id}`, SK: 'META' },
              // Optimistic lock: two reviewers can't double-decide.
              ConditionExpression: '#status = :old',
              UpdateExpression: updateExpr,
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: updateValues,
            },
          },
          {
            Put: {
              TableName: TABLE,
              Item: {
                PK: `APP#${id}`,
                SK: `EVENT#${now}#1`,
                entity: 'Event',
                status: transition.to,
                at: now,
                actor: who.email,
                note: note ?? null,
              },
            },
          },
          {
            Update: {
              TableName: TABLE,
              Key: { PK: 'STATS', SK: 'CURRENT' },
              UpdateExpression: 'ADD #counts.#old :neg, #counts.#new :one SET updatedAt = :now',
              ExpressionAttributeNames: { '#counts': 'counts', '#old': current, '#new': transition.to },
              ExpressionAttributeValues: { ':neg': -1, ':one': 1, ':now': now },
            },
          },
          {
            // Applicant's notification feed (the bell in the header).
            Put: {
              TableName: TABLE,
              Item: {
                PK: `USER#${meta.Item.applicantSub}`,
                SK: `NOTIF#${now}#${id}`,
                entity: 'Notification',
                appId: id,
                typeName: meta.Item.typeName,
                status: transition.to,
                note: note ?? null,
                at: now,
              },
            },
          },
        ],
      })
    );

    return json(200, { id, status: transition.to, decidedAt: isFinal ? now : undefined });
  },

  // --- inspections ---------------------------------------------------------
  // The phase after approval for types that require it: schedule → pass, or
  // schedule → fail → reschedule. A pass finals the permit (closedAt).

  'GET /api/admin/applications/{id}/inspections': async (event) => {
    requireAdmin(event);
    const id = pathParam(event, 'id');
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `APP#${id}`, ':sk': 'INSP#' },
      })
    );
    return json(200, { inspections: (res.Items ?? []).map(publicView) });
  },

  'POST /api/admin/applications/{id}/inspections': async (event) => {
    const who = requireAdmin(event);
    const id = pathParam(event, 'id');
    const body = parseBody<{ scheduledFor: string; note?: string }>(event);

    const scheduledFor = requireString(body.scheduledFor, 'scheduledFor', 10, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduledFor)) {
      throw new HttpError(400, "Field 'scheduledFor' must be a date (YYYY-MM-DD)");
    }
    const note = body.note ? requireString(body.note, 'note', 1, 500) : undefined;

    const meta = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `APP#${id}`, SK: 'META' } }));
    if (!meta.Item) throw new HttpError(404, 'Application not found');
    if (meta.Item.status !== 'approved') throw new HttpError(409, 'Inspections apply to approved permits');
    const state = meta.Item.inspection;
    if (state !== 'required' && state !== 'failed') {
      throw new HttpError(409, `Cannot schedule: inspection is '${state ?? 'not required'}'`);
    }

    const existing = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `APP#${id}`, ':sk': 'INSP#' },
        Select: 'COUNT',
      })
    );
    const n = (existing.Count ?? 0) + 1;
    const now = new Date().toISOString();
    const label = n > 1 ? 'Reinspection' : 'Final inspection';
    const fmtDay = new Date(`${scheduledFor}T12:00:00Z`).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });

    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE,
              ConditionExpression: 'attribute_not_exists(PK)',
              Item: {
                PK: `APP#${id}`,
                SK: `INSP#${String(n).padStart(2, '0')}`,
                entity: 'Inspection',
                n,
                result: 'scheduled',
                scheduledFor,
                scheduledAt: now,
                scheduledBy: who.email,
                note: note ?? null,
              },
            },
          },
          {
            Update: {
              TableName: TABLE,
              Key: { PK: `APP#${id}`, SK: 'META' },
              ConditionExpression: 'inspection IN (:req, :fail)',
              UpdateExpression: 'SET inspection = :sched',
              ExpressionAttributeValues: { ':req': 'required', ':fail': 'failed', ':sched': 'scheduled' },
            },
          },
          {
            Put: {
              TableName: TABLE,
              Item: {
                PK: `APP#${id}`,
                SK: `EVENT#${now}#3`,
                entity: 'Event',
                status: 'approved',
                at: now,
                actor: who.email,
                note: note ?? null,
                title: `${label} scheduled for ${fmtDay}`,
                tone: 'warn',
              },
            },
          },
          {
            Put: {
              TableName: TABLE,
              Item: {
                PK: `USER#${meta.Item.applicantSub}`,
                SK: `NOTIF#${now}#${id}`,
                entity: 'Notification',
                appId: id,
                typeName: meta.Item.typeName,
                status: 'approved',
                note: note ?? null,
                at: now,
                title: `${label} scheduled for ${fmtDay}`,
                tone: 'warn',
              },
            },
          },
        ],
      })
    );

    return json(201, { inspection: n, scheduledFor, state: 'scheduled' });
  },

  'POST /api/admin/applications/{id}/inspections/{n}/result': async (event) => {
    const who = requireAdmin(event);
    const id = pathParam(event, 'id');
    const n = Number(pathParam(event, 'n'));
    if (!Number.isInteger(n) || n < 1 || n > 99) throw new HttpError(400, 'Invalid inspection number');
    const body = parseBody<{ result: 'pass' | 'fail'; note?: string }>(event);
    if (body.result !== 'pass' && body.result !== 'fail') {
      throw new HttpError(400, "Field 'result' must be 'pass' or 'fail'");
    }
    const note = body.note ? requireString(body.note, 'note', 1, 500) : undefined;

    const sk = `INSP#${String(n).padStart(2, '0')}`;
    const [meta, insp] = await Promise.all([
      ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `APP#${id}`, SK: 'META' } })),
      ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `APP#${id}`, SK: sk } })),
    ]);
    if (!meta.Item || !insp.Item) throw new HttpError(404, 'Inspection not found');
    if (insp.Item.result !== 'scheduled') {
      throw new HttpError(409, `Inspection ${n} was already recorded as '${insp.Item.result}'`);
    }

    const passed = body.result === 'pass';
    const now = new Date().toISOString();
    const title = passed
      ? 'Final inspection passed. Permit closed out.'
      : 'Inspection failed. Correct and schedule a reinspection.';

    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: { PK: `APP#${id}`, SK: sk },
              ConditionExpression: '#r = :sched',
              UpdateExpression: 'SET #r = :res, recordedAt = :now, inspector = :who' + (note ? ', note = :note' : ''),
              ExpressionAttributeNames: { '#r': 'result' },
              ExpressionAttributeValues: {
                ':sched': 'scheduled',
                ':res': passed ? 'passed' : 'failed',
                ':now': now,
                ':who': who.email,
                ...(note ? { ':note': note } : {}),
              },
            },
          },
          {
            Update: {
              TableName: TABLE,
              Key: { PK: `APP#${id}`, SK: 'META' },
              UpdateExpression: passed
                ? 'SET inspection = :state, closedAt = :now'
                : 'SET inspection = :state',
              ExpressionAttributeValues: passed
                ? { ':state': 'passed', ':now': now }
                : { ':state': 'failed' },
            },
          },
          {
            Put: {
              TableName: TABLE,
              Item: {
                PK: `APP#${id}`,
                SK: `EVENT#${now}#3`,
                entity: 'Event',
                status: 'approved',
                at: now,
                actor: who.email,
                note: note ?? null,
                title,
                tone: passed ? 'ok' : 'bad',
              },
            },
          },
          {
            Put: {
              TableName: TABLE,
              Item: {
                PK: `USER#${meta.Item.applicantSub}`,
                SK: `NOTIF#${now}#${id}`,
                entity: 'Notification',
                appId: id,
                typeName: meta.Item.typeName,
                status: 'approved',
                note: note ?? null,
                at: now,
                title,
                tone: passed ? 'ok' : 'bad',
              },
            },
          },
        ],
      })
    );

    return json(200, { inspection: n, result: passed ? 'passed' : 'failed', state: passed ? 'passed' : 'failed' });
  },

  'GET /api/admin/applications/{id}/attachments': async (event) => {
    requireAdmin(event);
    const id = pathParam(event, 'id');
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `APP#${id}`, ':sk': 'ATT#' },
      })
    );
    const attachments = await Promise.all(
      (res.Items ?? [])
        .filter((a) => a.status === 'uploaded')
        .map(async (a) => ({
          ...publicView(a),
          downloadUrl: await presignDownload(String(a.s3Key), String(a.filename)),
        }))
    );
    return json(200, { attachments });
  },

  'GET /api/admin/metrics': async (event) => {
    requireAdmin(event);
    const [current, monthly, oldestSubmitted] = await Promise.all([
      ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: 'STATS', SK: 'CURRENT' } })),
      ddb.send(
        new QueryCommand({
          TableName: TABLE,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: { ':pk': 'STATS', ':sk': 'MONTH#' },
        })
      ),
      ddb.send(
        new QueryCommand({
          TableName: TABLE,
          IndexName: 'GSI2',
          KeyConditionExpression: 'GSI2PK = :pk',
          ExpressionAttributeValues: { ':pk': 'STATUS#submitted' },
          ScanIndexForward: true,
          Limit: 1,
        })
      ),
    ]);

    const oldest = oldestSubmitted.Items?.[0];
    const oldestPendingDays = oldest
      ? Math.floor((Date.now() - new Date(String(oldest.submittedAt)).getTime()) / 86400_000)
      : 0;

    return json(200, {
      current: current.Item ? publicView(current.Item) : null,
      monthly: (monthly.Items ?? []).map(publicView),
      oldestPendingDays,
    });
  },

  'GET /api/admin/permit-types': async (event) => {
    requireAdmin(event);
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': 'CATALOG', ':sk': 'TYPE#' },
      })
    );
    const types = (res.Items ?? []).map(publicView).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return json(200, { types });
  },

  'POST /api/admin/permit-types': async (event) => {
    requireAdmin(event);
    const body = parseBody<{
      slug?: string;
      name: string;
      description: string;
      category: string;
      fee: number;
      processingDays: number;
      active?: boolean;
      requiresInspection?: boolean;
    }>(event);

    const name = requireString(body.name, 'name', 3, 100);
    const description = requireString(body.description, 'description', 10, 500);
    const category = requireString(body.category, 'category', 2, 40);
    if (typeof body.fee !== 'number' || body.fee < 0 || body.fee > 100000) {
      throw new HttpError(400, "Field 'fee' must be a number between 0 and 100000");
    }
    if (typeof body.processingDays !== 'number' || body.processingDays < 1 || body.processingDays > 365) {
      throw new HttpError(400, "Field 'processingDays' must be 1-365");
    }

    const slug =
      body.slug?.trim() ||
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);

    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: 'CATALOG',
          SK: `TYPE#${slug}`,
          entity: 'PermitType',
          slug,
          name,
          description,
          category,
          fee: body.fee,
          processingDays: body.processingDays,
          active: body.active ?? true,
          requiresInspection: body.requiresInspection ?? false,
        },
      })
    );

    return json(200, { slug });
  },
});
