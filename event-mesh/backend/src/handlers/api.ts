// The producer + read side of the mesh:
//   POST /api/requests      validate -> daily cap -> PutEvents -> first hop
//   GET  /api/requests      recent requests for the live feed
//   GET  /api/requests/{id} full trace (META + hops) for the flow map
//   GET  /api/stats         lifetime counters + live DLQ depths + today's cap
//   POST /api/redrive       operator redrive: DLQ -> its work queue

import { randomUUID } from 'node:crypto';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { GetQueueAttributesCommand, SQSClient, StartMessageMoveTaskCommand } from '@aws-sdk/client-sqs';
import { GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { HttpError, json, parseBody, requireOneOf, requireString, router } from '../lib/http.js';
import { addHop, bumpStats, ddb, ensureMeta, getTrace, shortId, ttl } from '../lib/trace.js';

const TABLE = process.env.TABLE_NAME!;
const BUS = process.env.BUS_NAME!;
const SOURCE = process.env.EVENT_SOURCE!;
const LIMIT = Number(process.env.GLOBAL_DAILY_LIMIT ?? 1000);
const QUEUES: Record<string, { queueUrl: string; queueArn: string; dlqUrl: string; dlqArn: string }> =
  JSON.parse(process.env.QUEUES_JSON!);

const CATEGORIES = Object.keys(QUEUES); // roads, utilities, parks

const eb = new EventBridgeClient({});
const sqs = new SQSClient({});

/** Global daily abuse cap — atomic conditional counter, 429 past the limit. */
async function takeDailyToken(): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `USAGE#${day}`, SK: 'GLOBAL' },
        UpdateExpression: 'ADD #c :one SET #t = if_not_exists(#t, :ttl)',
        ConditionExpression: 'attribute_not_exists(#c) OR #c < :limit',
        ExpressionAttributeNames: { '#c': 'count', '#t': 'ttl' },
        ExpressionAttributeValues: { ':one': 1, ':limit': LIMIT, ':ttl': ttl() },
      })
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new HttpError(429, `Daily demo limit reached (${LIMIT} requests/day). The mesh reopens at midnight UTC.`);
    }
    throw err;
  }
}

interface SubmitBody {
  category?: unknown;
  priority?: unknown;
  description?: unknown;
  simulate?: unknown;
}

async function submit(event: Parameters<ReturnType<typeof router>>[0]) {
  const body = parseBody<SubmitBody>(event);
  const category = requireOneOf(body.category, 'category', CATEGORIES);
  const priority = requireOneOf(body.priority ?? 'normal', 'priority', ['normal', 'urgent']);
  const simulate = requireOneOf(body.simulate ?? 'none', 'simulate', ['none', 'fail']);
  const description = requireString(body.description, 'description', 3, 300);

  await takeDailyToken();

  const requestId = randomUUID();
  const detail = { requestId, category, priority, description, simulate, origin: 'visitor' };

  await ensureMeta(detail);
  await eb.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: BUS,
          Source: SOURCE,
          DetailType: 'service.request.submitted',
          Detail: JSON.stringify(detail),
        },
      ],
    })
  );

  const matches = [`category=${category} → ${category} queue`, 'all requests → SNS fan-out'];
  if (priority === 'urgent') matches.push('priority=urgent → escalation workflow');
  await addHop(requestId, 'published', `published to the evt-bus — matched rules: ${matches.join('; ')}`, 'api');
  await bumpStats(['events']);

  return json(202, { requestId, shortId: shortId(requestId) });
}

async function trace(event: Parameters<ReturnType<typeof router>>[0]) {
  const id = event.pathParameters?.id ?? '';
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, 'Malformed request id');
  const t = await getTrace(id);
  if (!t.meta) throw new HttpError(404, 'No such request (traces expire after 48h)');
  return json(200, t);
}

async function recent() {
  // The table only ever holds ~48h of TTL'd traces, so a filtered Scan is
  // proportionate here; a GSI would be warranted at real volume.
  const res = await ddb.send(
    new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'SK = :meta',
      ExpressionAttributeValues: { ':meta': 'META' },
    })
  );
  const requests = (res.Items ?? [])
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 30)
    .map((i) => ({
      requestId: String(i.PK).slice(4),
      shortId: i.shortId,
      category: i.category,
      priority: i.priority,
      description: i.description,
      simulate: i.simulate,
      origin: i.origin,
      status: i.status,
      escalation: i.escalation,
      createdAt: i.createdAt,
    }));
  return json(200, { requests });
}

async function stats() {
  const totalsRes = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: 'STATS', SK: 'TOTALS' } })
  );
  const { PK: _pk, SK: _sk, ...totals } = totalsRes.Item ?? {};

  const depths: Record<string, number> = {};
  await Promise.all(
    Object.entries(QUEUES).map(async ([dept, q]) => {
      const attrs = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: q.dlqUrl,
          AttributeNames: ['ApproximateNumberOfMessages'],
        })
      );
      depths[dept] = Number(attrs.Attributes?.ApproximateNumberOfMessages ?? 0);
    })
  );

  const day = new Date().toISOString().slice(0, 10);
  const usageRes = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { PK: `USAGE#${day}`, SK: 'GLOBAL' } })
  );

  return json(200, {
    totals,
    dlq: { depths, total: Object.values(depths).reduce((a, b) => a + b, 0) },
    usage: { used: Number(usageRes.Item?.count ?? 0), limit: LIMIT },
  });
}

async function redrive(event: Parameters<ReturnType<typeof router>>[0]) {
  const body = parseBody<{ queue?: unknown }>(event);
  const dept = requireOneOf(body.queue, 'queue', CATEGORIES);
  const q = QUEUES[dept];
  try {
    await sqs.send(
      new StartMessageMoveTaskCommand({ SourceArn: q.dlqArn, DestinationArn: q.queueArn })
    );
  } catch (err: unknown) {
    // Racing a second click, or an empty DLQ — both fine to surface gently.
    console.error('redrive', err);
    throw new HttpError(409, 'Redrive not started — the DLQ may be empty or a move is already running');
  }
  await bumpStats(['redrives']);
  return json(202, { started: true, queue: dept });
}

export const handler = router({
  'POST /api/requests': submit,
  'GET /api/requests': recent,
  'GET /api/requests/{id}': trace,
  'GET /api/stats': stats,
  'POST /api/redrive': redrive,
});
