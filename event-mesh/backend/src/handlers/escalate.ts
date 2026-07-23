// All three escalation workflow steps, dispatched on `action`. Dispatch
// throws a transient error on its FIRST attempt for every request — checked
// against the trace, not a dice roll — so the Step Functions retry policy
// (3s backoff) fires visibly and deterministically in every demo.

import { addHop, bumpStats, ensureMeta, getTrace, setMeta, type RequestDetail } from '../lib/trace.js';

interface StepInput {
  action: 'triage' | 'dispatch' | 'resolve';
  detail: RequestDetail;
}

export async function handler({ action, detail }: StepInput): Promise<void> {
  const id = detail.requestId;

  switch (action) {
    case 'triage': {
      await ensureMeta(detail);
      await setMeta(id, 'escalation', 'in-progress');
      await addHop(id, 'sfn-triage', 'urgent request triaged: severity confirmed, on-call crew located', 'workflow');
      return;
    }

    case 'dispatch': {
      const { hops } = await getTrace(id);
      const attempt = hops.filter((h) => h.hop === 'sfn-dispatch-attempt').length + 1;

      if (attempt === 1) {
        await addHop(id, 'sfn-dispatch-attempt', 'attempt 1: field crew radio timed out (simulated transient fault); the workflow retries with 3s backoff', 'workflow');
        const err = new Error('field crew radio timeout (simulated)');
        err.name = 'TransientDispatchError'; // matched by the state's Retry policy
        throw err;
      }

      await addHop(id, 'sfn-dispatch-attempt', `attempt ${attempt}: crew acknowledged`, 'workflow');
      await addHop(id, 'sfn-dispatched', 'crew assigned and en route; the retry policy absorbed the transient fault, invisible to the citizen', 'workflow');
      await bumpStats(['retries']);
      return;
    }

    case 'resolve': {
      await addHop(id, 'sfn-resolved', 'escalation closed; urgent request resolved end to end', 'workflow');
      await setMeta(id, 'escalation', 'resolved');
      await bumpStats(['escalations']);
      return;
    }
  }
}
