// One consumer, six queues (three department dispatch queues, the SNS audit
// queue, and the two block-order race queues), told apart by eventSourceARN.
// Failures are reported per-message (ReportBatchItemFailures) so a poison
// message retries alone.
//
// The poison-message story, end to end:
//   simulate=fail  -> throw on every receive; hop per attempt; on the 3rd
//                     attempt the message is about to exceed maxReceiveCount,
//                     so we record "dead-lettered" before SQS moves it.
//   after redrive  -> StartMessageMoveTask delivers it back here as a fresh
//                     message; the existing "dead-lettered" hop tells us an
//                     operator intervened, so it now processes as "recovered".
//
// Replayed events (top-level "replay-name" in the envelope) run as their own
// "second section" trace — resolveEvent hashes them a fresh requestId — so a
// replayed poison message dead-letters again, honestly, on its own record.

import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { addHop, bumpStats, ddb, ensureMeta, getTrace, resolveEvent, setMeta, ttl } from '../lib/trace.js';

const TABLE = process.env.TABLE_NAME!;
const MAX_RECEIVES = 3; // must match the queues' redrive maxReceiveCount

function queueName(record: SQSRecord): string {
  return record.eventSourceARN.split(':').pop() ?? '';
}

async function handleDispatch(record: SQSRecord, dept: string): Promise<void> {
  const detail = resolveEvent(JSON.parse(record.body));
  const id = detail.requestId;
  await ensureMeta(detail);

  if (detail.simulate === 'fail') {
    const { hops } = await getTrace(id);
    if (hops.some((h) => h.hop === 'dead-lettered')) {
      await addHop(id, 'recovered', `redriven message processed cleanly by the ${dept} worker; operator intervention closed the loop`, dept);
      await setMeta(id, 'status', 'recovered');
      await bumpStats(['processed', 'recovered']);
      return;
    }

    const attempt = Number(record.attributes.ApproximateReceiveCount);
    if (attempt >= MAX_RECEIVES) {
      await addHop(id, 'dead-lettered', `attempt ${attempt} of ${MAX_RECEIVES} failed; SQS moves the message to the ${dept} dead-letter queue on its next delivery cycle (~30s)`, dept);
      await setMeta(id, 'status', 'dead-lettered');
      await bumpStats(['deadLetters']);
    } else {
      await addHop(id, 'attempt-failed', `simulated crash on attempt ${attempt} of ${MAX_RECEIVES}; SQS will redeliver after the 30s visibility timeout`, dept);
    }
    throw new Error(`simulated processing failure (attempt ${attempt})`);
  }

  await addHop(id, 'dequeued', `picked up from the ${dept} dispatch queue`, dept);
  await addHop(id, 'processed', `work order created in the ${dept} department system`, dept);
  await setMeta(id, 'status', 'completed');
  await bumpStats(['processed']);
}

async function handleAudit(record: SQSRecord): Promise<void> {
  // raw_message_delivery=true on the SNS->SQS subscription keeps the body
  // identical to the dispatch queues': the full EventBridge event.
  const detail = resolveEvent(JSON.parse(record.body));
  await ensureMeta(detail);
  await addHop(detail.requestId, 'audit-logged', 'durable compliance copy recorded from the SNS fan-out (queue subscriber)', 'audit');
  await bumpStats(['audits']);
}

// A race car arriving. Its position is an atomic counter on the race META —
// concurrent standard-queue invokes race each other TO that counter, which is
// exactly the disorder the exhibit is about; the FIFO queue's single message
// group arrives sequentially, so its positions always equal its seq numbers.
async function handleRace(record: SQSRecord, queue: 'standard' | 'fifo'): Promise<void> {
  const { raceId, seq } = JSON.parse(record.body) as { raceId?: string; seq?: number };
  if (typeof raceId !== 'string' || !/^[0-9a-f-]{36}$/.test(raceId) || typeof seq !== 'number') {
    console.error('race message with a malformed body dropped', record.messageId);
    return;
  }
  const field = queue === 'standard' ? 'stdArrived' : 'fifoArrived';
  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `RACE#${raceId}`, SK: 'META' },
      UpdateExpression: 'ADD #f :one SET #t = if_not_exists(#t, :ttl)',
      ExpressionAttributeNames: { '#f': field, '#t': 'ttl' },
      ExpressionAttributeValues: { ':one': 1, ':ttl': ttl() },
      ReturnValues: 'ALL_NEW',
    })
  );
  const pos = Number(res.Attributes?.[field] ?? 0);
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `RACE#${raceId}`,
        SK: `CAR#${queue}#${String(pos).padStart(2, '0')}`,
        queue,
        pos,
        seq,
        at: new Date().toISOString(),
        ttl: ttl(),
      },
    })
  );
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const name = queueName(record);
    try {
      if (name === 'evt-audit') await handleAudit(record);
      else if (name === 'evt-race-standard') await handleRace(record, 'standard');
      else if (name === 'evt-race.fifo') await handleRace(record, 'fifo');
      else await handleDispatch(record, name.replace('evt-dispatch-', ''));
    } catch (err) {
      console.error(`message ${record.messageId} failed on ${name}`, err);
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
}
