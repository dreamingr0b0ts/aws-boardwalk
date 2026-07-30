// The producer + read side of the mesh:
//   POST /api/requests      validate -> daily cap -> PutEvents -> first hop
//   GET  /api/requests      recent requests for the live feed
//   GET  /api/requests/{id} full trace (META + hops) for the flow map
//   GET  /api/stats         lifetime counters + live DLQ depths + today's caps
//   POST /api/redrive       operator redrive: DLQ -> its work queue
//   GET  /api/dlq/{dept}    read the bad-order cards: peek a DLQ's messages
//   POST /api/pattern-test  the interlocking tester (TestEventPattern)
//   POST /api/race          the block order: 10 cars to standard + FIFO queues
//   GET  /api/race/{id}     race trace: arrival order per queue
//   POST /api/replay        the second section: replay the archive onto the bus
//   GET  /api/replay        archive stats + current/last replay state

import { randomUUID } from 'node:crypto';
import {
  DescribeArchiveCommand,
  DescribeReplayCommand,
  EventBridgeClient,
  PutEventsCommand,
  StartReplayCommand,
  TestEventPatternCommand,
} from '@aws-sdk/client-eventbridge';
import {
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient,
  StartMessageMoveTaskCommand,
} from '@aws-sdk/client-sqs';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { HttpError, json, parseBody, requireOneOf, requireString, router } from '../lib/http.js';
import { addHop, bumpStats, ddb, ensureMeta, getTrace, resolveEvent, shortId, ttl } from '../lib/trace.js';

const TABLE = process.env.TABLE_NAME!;
const BUS = process.env.BUS_NAME!;
const BUS_ARN = process.env.BUS_ARN!;
const SOURCE = process.env.EVENT_SOURCE!;
const ARCHIVE_NAME = process.env.ARCHIVE_NAME!;
const ARCHIVE_ARN = process.env.ARCHIVE_ARN!;
const LIMIT = Number(process.env.GLOBAL_DAILY_LIMIT ?? 1000);
const PATTERN_LIMIT = Number(process.env.PATTERN_DAILY_LIMIT ?? 500);
const RACE_LIMIT = Number(process.env.RACE_DAILY_LIMIT ?? 100);
const REPLAY_LIMIT = Number(process.env.REPLAY_DAILY_LIMIT ?? 10);
const QUEUES: Record<string, { queueUrl: string; queueArn: string; dlqUrl: string; dlqArn: string }> =
  JSON.parse(process.env.QUEUES_JSON!);
const RACE: { standardUrl: string; fifoUrl: string } = JSON.parse(process.env.RACE_JSON!);
const RULE_PATTERNS: { name: string; description: string; pattern: string }[] =
  JSON.parse(process.env.RULE_PATTERNS_JSON!);

const CATEGORIES = Object.keys(QUEUES); // roads, utilities, parks

const eb = new EventBridgeClient({});
const sqs = new SQSClient({});

/** Per-exhibit daily abuse caps — atomic conditional counters, 429 past the limit. */
async function takeDailyToken(kind = 'GLOBAL', limit = LIMIT, label = 'requests'): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `USAGE#${day}`, SK: kind },
        UpdateExpression: 'ADD #c :one SET #t = if_not_exists(#t, :ttl)',
        ConditionExpression: 'attribute_not_exists(#c) OR #c < :limit',
        ExpressionAttributeNames: { '#c': 'count', '#t': 'ttl' },
        ExpressionAttributeValues: { ':one': 1, ':limit': limit, ':ttl': ttl() },
      })
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new HttpError(429, `Daily demo limit reached (${limit} ${label}/day). The mesh reopens at midnight UTC.`);
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
  await addHop(requestId, 'published', `published to the evt-bus; matched rules: ${matches.join('; ')}`, 'api');
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
      FilterExpression: 'SK = :meta AND begins_with(PK, :req)',
      ExpressionAttributeValues: { ':meta': 'META', ':req': 'REQ#' },
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
      replayOf: i.replayOf,
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
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `USAGE#${day}` },
    })
  );
  const counts = Object.fromEntries((usageRes.Items ?? []).map((i) => [i.SK, Number(i.count ?? 0)]));

  return json(200, {
    totals,
    dlq: { depths, total: Object.values(depths).reduce((a, b) => a + b, 0) },
    usage: {
      used: counts.GLOBAL ?? 0,
      limit: LIMIT,
      pattern: { used: counts.PATTERN ?? 0, limit: PATTERN_LIMIT },
      race: { used: counts.RACE ?? 0, limit: RACE_LIMIT },
      replay: { used: counts.REPLAY ?? 0, limit: REPLAY_LIMIT },
    },
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
    throw new HttpError(409, 'Redrive not started; the DLQ may be empty or a move is already running');
  }
  await bumpStats(['redrives']);
  return json(202, { started: true, queue: dept });
}

// ---- the bad-order cards: peek a DLQ without consuming it -------------------

async function dlqPeek(event: Parameters<ReturnType<typeof router>>[0]) {
  const dept = requireOneOf(event.pathParameters?.dept, 'dept', CATEGORIES);
  // VisibilityTimeout=0 makes this a true peek: the message never leaves the
  // visible state, so a redrive started right after the reading still finds
  // it. (VisibilityTimeout=1 lost a live race: StartMessageMoveTask
  // snapshotted the queue during the 1s in-flight window, "moved" 0 messages,
  // and completed.) WaitTimeSeconds=1 long-polls all SQS hosts so the cards
  // come back complete. Peeking still bumps ApproximateReceiveCount —
  // harmless on a DLQ, and the card labels the count "incl. readings".
  const res = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: QUEUES[dept].dlqUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      VisibilityTimeout: 0,
      AttributeNames: ['All'],
      MessageAttributeNames: ['All'],
    })
  );
  const cards = (res.Messages ?? []).map((m) => {
    let card: Record<string, unknown> = {};
    try {
      const detail = resolveEvent(JSON.parse(m.Body ?? '{}'));
      card = {
        requestId: detail.requestId,
        shortId: shortId(detail.requestId),
        category: detail.category,
        description: detail.description,
        replayOf: detail.replayOf,
      };
    } catch {
      card = { description: '(unparseable body)' };
    }
    const a = m.Attributes ?? {};
    return {
      ...card,
      receiveCount: Number(a.ApproximateReceiveCount ?? 0),
      sentAt: a.SentTimestamp ? new Date(Number(a.SentTimestamp)).toISOString() : undefined,
      firstReceivedAt: a.ApproximateFirstReceiveTimestamp
        ? new Date(Number(a.ApproximateFirstReceiveTimestamp)).toISOString()
        : undefined,
      // Present only on messages that SQS itself moved here — the receipt
      // that this car came off a real dispatch track.
      sourceQueue: a.DeadLetterQueueSourceArn?.split(':').pop(),
    };
  });
  return json(200, { queue: dept, count: cards.length, cards });
}

// ---- the interlocking tester: TestEventPattern under glass -------------------

async function patternTest(event: Parameters<ReturnType<typeof router>>[0]) {
  const body = parseBody<{ event?: unknown; pattern?: unknown }>(event);
  if (typeof body.event !== 'object' || body.event === null || Array.isArray(body.event)) {
    throw new HttpError(400, "Field 'event' must be a JSON object");
  }
  if (typeof body.pattern !== 'object' || body.pattern === null || Array.isArray(body.pattern)) {
    throw new HttpError(400, "Field 'pattern' must be a JSON object");
  }
  const patternStr = JSON.stringify(body.pattern);
  if (patternStr.length > 4096 || JSON.stringify(body.event).length > 4096) {
    throw new HttpError(400, 'Event and pattern are capped at 4KB each');
  }

  await takeDailyToken('PATTERN', PATTERN_LIMIT, 'pattern tests');

  // TestEventPattern insists on a complete envelope; fill whatever the
  // visitor left out so they can think in terms of source/detail-type/detail.
  // (Fictional account id on purpose — it's echoed back in the response.)
  const normalized = {
    version: '0',
    id: randomUUID(),
    'detail-type': 'service.request.submitted',
    source: SOURCE,
    account: '111122223333',
    time: new Date().toISOString(),
    region: 'us-east-1',
    resources: [],
    detail: {},
    ...(body.event as Record<string, unknown>),
  };
  const eventStr = JSON.stringify(normalized);

  const test = async (pattern: string) =>
    (await eb.send(new TestEventPatternCommand({ Event: eventStr, EventPattern: pattern }))).Result === true;

  let matched: boolean;
  try {
    matched = await test(patternStr);
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string };
    // EventBridge's own reason strings are the teaching material here.
    if (e.name === 'InvalidEventPatternException') {
      throw new HttpError(400, `EventBridge rejected the pattern. ${e.message ?? ''}`);
    }
    if (e.name === 'ValidationException') {
      throw new HttpError(400, `EventBridge rejected the event. ${e.message ?? ''}`);
    }
    throw err;
  }

  // The same event against the mesh's five REAL rules (patterns read from the
  // deployed rule resources, so this can never drift from the actual bus).
  const rules = await Promise.all(
    RULE_PATTERNS.map(async (r) => ({
      name: r.name,
      description: r.description,
      pattern: JSON.parse(r.pattern),
      matched: await test(r.pattern),
    }))
  );

  await bumpStats(['patternTests']);
  return json(200, { matched, rules, event: normalized });
}

// ---- the block order: standard vs FIFO race ----------------------------------

const CARS = 10;
const DUP_SEQ = 7;

async function race() {
  await takeDailyToken('RACE', RACE_LIMIT, 'races');

  const raceId = randomUUID();
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: `RACE#${raceId}`, SK: 'META', createdAt: new Date().toISOString(), cars: CARS, dupSeq: DUP_SEQ, ttl: ttl() },
    })
  );

  // The same cut of cars, the same single SendMessageBatch call, to both
  // queues — any reordering after this point is delivery, not the producer.
  const entries = (fifo: boolean) =>
    Array.from({ length: CARS }, (_, i) => {
      const seq = i + 1;
      return {
        Id: `car-${seq}`,
        MessageBody: JSON.stringify({ raceId, seq }),
        ...(fifo ? { MessageGroupId: raceId, MessageDeduplicationId: `${raceId}-${seq}` } : {}),
      };
    });
  const [stdRes, fifoRes] = await Promise.all([
    sqs.send(new SendMessageBatchCommand({ QueueUrl: RACE.standardUrl, Entries: entries(false) })),
    sqs.send(new SendMessageBatchCommand({ QueueUrl: RACE.fifoUrl, Entries: entries(true) })),
  ]);
  const failed = [...(stdRes.Failed ?? []), ...(fifoRes.Failed ?? [])];
  if (failed.length) {
    console.error('race batch failures', failed);
    throw new HttpError(502, `SQS declined ${failed.length} of the cars; send another cut`);
  }

  // The dedup exhibit: offer car 7 a second time with the SAME deduplication
  // id. SQS accepts the send and answers with the ORIGINAL MessageId — the
  // receipt that the duplicate was absorbed, not delivered.
  const firstId = fifoRes.Successful?.find((s) => s.Id === `car-${DUP_SEQ}`)?.MessageId;
  const dup = await sqs.send(
    new SendMessageCommand({
      QueueUrl: RACE.fifoUrl,
      MessageBody: JSON.stringify({ raceId, seq: DUP_SEQ }),
      MessageGroupId: raceId,
      MessageDeduplicationId: `${raceId}-${DUP_SEQ}`,
    })
  );
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `RACE#${raceId}`, SK: 'META' },
      UpdateExpression: 'SET dupFirstMessageId = :f, dupMessageId = :d, dupAbsorbed = :a',
      ExpressionAttributeValues: {
        ':f': firstId ?? 'unknown',
        ':d': dup.MessageId ?? 'unknown',
        ':a': Boolean(firstId) && firstId === dup.MessageId,
      },
    })
  );

  await bumpStats(['races']);
  return json(202, { raceId });
}

async function raceTrace(event: Parameters<ReturnType<typeof router>>[0]) {
  const id = event.pathParameters?.id ?? '';
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, 'Malformed race id');
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `RACE#${id}` },
    })
  );
  const items = res.Items ?? [];
  const meta = items.find((i) => i.SK === 'META');
  if (!meta) throw new HttpError(404, 'No such race (races expire with the nightly reset)');
  const arrivals = (queue: string) =>
    items
      .filter((i) => typeof i.SK === 'string' && i.SK.startsWith(`CAR#${queue}#`))
      .sort((a, b) => Number(a.pos) - Number(b.pos))
      .map((i) => ({ pos: i.pos, seq: i.seq, at: i.at }));
  return json(200, {
    meta: {
      createdAt: meta.createdAt,
      cars: meta.cars,
      dupSeq: meta.dupSeq,
      dupAbsorbed: meta.dupAbsorbed,
      dupFirstMessageId: meta.dupFirstMessageId,
      dupMessageId: meta.dupMessageId,
      stdArrived: meta.stdArrived ?? 0,
      fifoArrived: meta.fifoArrived ?? 0,
    },
    arrivals: { standard: arrivals('standard'), fifo: arrivals('fifo') },
  });
}

// ---- the second section: archive replay ---------------------------------------

const WINDOWS: Record<string, number> = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3 };
const LOCK_STALE_MS = 15 * 60e3;

async function startReplay(event: Parameters<ReturnType<typeof router>>[0]) {
  const body = parseBody<{ window?: unknown }>(event);
  const window = requireOneOf(body.window ?? '1h', 'window', Object.keys(WINDOWS));

  const now = Date.now();
  const replayName = `evt-replay-${now}`;

  // One second section at a time. The 409 carries the in-flight name so a
  // second visitor's page can attach to the run already on the board.
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: { PK: 'REPLAY', SK: 'LOCK', replayName, window, startedAt: new Date(now).toISOString(), ttl: ttl() },
        ConditionExpression: 'attribute_not_exists(PK) OR startedAt < :stale',
        ExpressionAttributeValues: { ':stale': new Date(now - LOCK_STALE_MS).toISOString() },
      })
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      const cur = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: 'REPLAY', SK: 'LOCK' } }));
      throw new HttpError(409, `A second section is already running (${cur.Item?.replayName ?? 'unknown'}). One replay at a time; watch that one instead.`);
    }
    throw err;
  }

  try {
    await takeDailyToken('REPLAY', REPLAY_LIMIT, 'replays');
    await eb.send(
      new StartReplayCommand({
        ReplayName: replayName,
        EventSourceArn: ARCHIVE_ARN,
        EventStartTime: new Date(now - WINDOWS[window]),
        EventEndTime: new Date(now),
        Destination: { Arn: BUS_ARN },
      })
    );
  } catch (err: unknown) {
    // Give the lock back on any failure so the exhibit isn't wedged.
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: 'REPLAY', SK: 'LOCK' } })).catch(() => {});
    if (err instanceof HttpError) throw err;
    console.error('start-replay', err);
    throw new HttpError(502, 'EventBridge declined to start the replay; try again shortly');
  }

  await bumpStats(['replays']);
  return json(202, { replayName, window });
}

async function replayStatus() {
  const [archiveRes, lockRes, lastRes] = await Promise.all([
    eb.send(new DescribeArchiveCommand({ ArchiveName: ARCHIVE_NAME })),
    ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: 'REPLAY', SK: 'LOCK' } })),
    ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: 'REPLAY', SK: 'LAST' } })),
  ]);

  const summarize = (i: Record<string, unknown> | undefined) =>
    i ? { replayName: i.replayName, window: i.window, state: i.state, startedAt: i.startedAt, finishedAt: i.finishedAt } : null;

  let current: Record<string, unknown> | null = null;
  let last = summarize(lastRes.Item);
  const lock = lockRes.Item;

  if (lock) {
    try {
      const rep = await eb.send(new DescribeReplayCommand({ ReplayName: String(lock.replayName) }));
      const state = rep.State ?? 'STARTING';
      const info = {
        replayName: lock.replayName,
        window: lock.window,
        state,
        startedAt: lock.startedAt,
        eventLastReplayedTime: rep.EventLastReplayedTime?.toISOString(),
      };
      if (state === 'COMPLETED' || state === 'CANCELLED' || state === 'FAILED') {
        const fin = { ...info, finishedAt: new Date().toISOString() };
        await Promise.all([
          ddb.send(new PutCommand({ TableName: TABLE, Item: { PK: 'REPLAY', SK: 'LAST', ...fin, ttl: ttl() } })),
          ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: 'REPLAY', SK: 'LOCK' } })),
        ]);
        last = summarize(fin);
      } else {
        current = info;
      }
    } catch (err: unknown) {
      if ((err as { name?: string }).name === 'ResourceNotFoundException') {
        // DescribeReplay can lag StartReplay by a beat; only treat the lock
        // as stale once it's old enough that the replay clearly never took.
        const age = Date.now() - new Date(String(lock.startedAt)).getTime();
        if (age > 60e3) {
          await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: 'REPLAY', SK: 'LOCK' } })).catch(() => {});
        } else {
          current = { replayName: lock.replayName, window: lock.window, state: 'STARTING', startedAt: lock.startedAt };
        }
      } else {
        throw err;
      }
    }
  }

  return json(200, {
    archive: {
      events: archiveRes.EventCount ?? 0,
      sizeBytes: archiveRes.SizeBytes ?? 0,
      state: archiveRes.State,
      retentionDays: archiveRes.RetentionDays,
    },
    current,
    last,
  });
}

export const handler = router({
  'POST /api/requests': submit,
  'GET /api/requests': recent,
  'GET /api/requests/{id}': trace,
  'GET /api/stats': stats,
  'POST /api/redrive': redrive,
  'GET /api/dlq/{dept}': dlqPeek,
  'POST /api/pattern-test': patternTest,
  'POST /api/race': race,
  'GET /api/race/{id}': raceTrace,
  'POST /api/replay': startReplay,
  'GET /api/replay': replayStatus,
});
