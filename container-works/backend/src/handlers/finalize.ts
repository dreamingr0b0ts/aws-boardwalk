import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { normalizeTask, saveRun } from '../lib/runs.js';

// EventBridge → here on every ECS task state change in the ctr cluster. This
// is what makes run records complete even when nobody is watching the
// dashboard: the daily scheduled run and any abandoned browser tab still get
// their final exit code, duration, and stopped reason persisted.

const doc = DynamoDBDocument.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const TABLE = process.env.TABLE_NAME!;

export const handler = async (event: { detail?: Record<string, unknown> }): Promise<void> => {
  const run = event.detail ? normalizeTask(event.detail) : null;
  if (!run) {
    console.warn('event without a task detail — ignoring');
    return;
  }
  await saveRun(doc, TABLE, run);
  console.log(`run ${run.runId} → ${run.lastStatus}${run.exitCode !== undefined ? ` (exit ${run.exitCode})` : ''}`);
};
