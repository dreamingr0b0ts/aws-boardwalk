// One consumer, four queues (three department dispatch queues + the SNS audit
// queue), told apart by eventSourceARN. Failures are reported per-message
// (ReportBatchItemFailures) so a poison message retries alone.
//
// The poison-message story, end to end:
//   simulate=fail  -> throw on every receive; hop per attempt; on the 3rd
//                     attempt the message is about to exceed maxReceiveCount,
//                     so we record "dead-lettered" before SQS moves it.
//   after redrive  -> StartMessageMoveTask delivers it back here as a fresh
//                     message; the existing "dead-lettered" hop tells us an
//                     operator intervened, so it now processes as "recovered".

import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { addHop, bumpStats, ensureMeta, getTrace, setMeta, type RequestDetail } from '../lib/trace.js';

const MAX_RECEIVES = 3; // must match the queues' redrive maxReceiveCount

function queueName(record: SQSRecord): string {
  return record.eventSourceARN.split(':').pop() ?? '';
}

// Heartbeat events (published by EventBridge Scheduler) carry no requestId —
// every copy of the event borrows the envelope's unique event id instead, so
// all fan-out legs still trace to the same request.
function eventDetail(body: string): RequestDetail {
  const evt = JSON.parse(body);
  return { ...evt.detail, requestId: evt.detail.requestId || evt.id };
}

async function handleDispatch(record: SQSRecord, dept: string): Promise<void> {
  const detail = eventDetail(record.body);
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
  const detail = eventDetail(record.body);
  await ensureMeta(detail);
  await addHop(detail.requestId, 'audit-logged', 'durable compliance copy recorded from the SNS fan-out (queue subscriber)', 'audit');
  await bumpStats(['audits']);
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const name = queueName(record);
    try {
      if (name === 'evt-audit') await handleAudit(record);
      else await handleDispatch(record, name.replace('evt-dispatch-', ''));
    } catch (err) {
      console.error(`message ${record.messageId} failed on ${name}`, err);
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
}
