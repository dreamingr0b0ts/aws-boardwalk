// The Lambda half of the SNS fan-out (the audit queue is the other half).
// In production this would send the citizen an SES email / SMS; the demo
// records the hop as its evidence.

import type { SNSEvent } from 'aws-lambda';
import { addHop, bumpStats, ensureMeta, resolveEvent } from '../lib/trace.js';

export async function handler(event: SNSEvent): Promise<void> {
  for (const record of event.Records) {
    // resolveEvent applies both shared conventions: heartbeats borrow the
    // envelope's event id, and replayed events get their own second-section
    // trace id.
    const detail = resolveEvent(JSON.parse(record.Sns.Message));
    await ensureMeta(detail);
    await addHop(
      detail.requestId,
      'notified',
      'citizen confirmation dispatched from the SNS topic (Lambda subscriber); production would send email/SMS here',
      'notifier'
    );
    await bumpStats(['notifications']);
  }
}
