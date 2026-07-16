// The Lambda half of the SNS fan-out (the audit queue is the other half).
// In production this would send the citizen an SES email / SMS; the demo
// records the hop as its evidence.

import type { SNSEvent } from 'aws-lambda';
import { addHop, bumpStats, ensureMeta, type RequestDetail } from '../lib/trace.js';

export async function handler(event: SNSEvent): Promise<void> {
  for (const record of event.Records) {
    // Heartbeats carry no requestId; fall back to the envelope's event id
    // (same convention as the worker) so all legs trace together.
    const evt = JSON.parse(record.Sns.Message);
    const detail: RequestDetail = { ...evt.detail, requestId: evt.detail.requestId || evt.id };
    await ensureMeta(detail);
    await addHop(
      detail.requestId,
      'notified',
      'citizen confirmation dispatched from the SNS topic (Lambda subscriber) — production would send email/SMS here',
      'notifier'
    );
    await bumpStats(['notifications']);
  }
}
