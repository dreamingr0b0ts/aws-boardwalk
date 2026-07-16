import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

// One normalized shape for every source of task state: the RunTask response
// (POST /api/runs), DescribeTasks (GET polling), and EventBridge ECS
// task-state-change events (finalize) all produce the same task object modulo
// Date-vs-ISO-string timestamps.

export interface RunRecord {
  runId: string;
  job: string;
  source: string;
  lastStatus: string;
  createdAt: string;
  pullStartedAt?: string;
  startedAt?: string;
  stoppedAt?: string;
  exitCode?: number;
  stoppedReason?: string;
  durationMs?: number;
}

const TTL_HOURS = 48;

export function normalizeTask(task: Record<string, any>): RunRecord | null {
  const taskArn: string | undefined = task?.taskArn;
  if (!taskArn) return null;

  const iso = (v: unknown): string | undefined => (v ? new Date(v as string).toISOString() : undefined);
  const env: Array<{ name: string; value: string }> =
    task.overrides?.containerOverrides?.find((c: any) => c.name === 'app')?.environment ?? [];
  const fromEnv = (name: string) => env.find((e) => e.name === name)?.value;

  const startedAt = iso(task.startedAt);
  const stoppedAt = iso(task.stoppedAt);
  const container = (task.containers ?? [])[0];

  return {
    runId: taskArn.split('/').pop()!,
    job: fromEnv('JOB') ?? 'report',
    source: fromEnv('SOURCE') ?? 'schedule', // the daily schedule is the only launcher that skips the API
    lastStatus: task.lastStatus ?? 'PROVISIONING',
    createdAt: iso(task.createdAt) ?? new Date().toISOString(),
    pullStartedAt: iso(task.pullStartedAt),
    startedAt,
    stoppedAt,
    exitCode: typeof container?.exitCode === 'number' ? container.exitCode : undefined,
    stoppedReason: task.stoppedReason || undefined,
    durationMs:
      startedAt && stoppedAt ? new Date(stoppedAt).getTime() - new Date(startedAt).getTime() : undefined,
  };
}

// Every write refreshes both the run record and its recent-runs pointer.
// Writes are idempotent per state (keys are deterministic, ttl derives from
// createdAt), so replayed EventBridge events are harmless.
export async function saveRun(doc: DynamoDBDocument, table: string, run: RunRecord): Promise<void> {
  const ttl = Math.floor(new Date(run.createdAt).getTime() / 1000) + TTL_HOURS * 3600;
  await Promise.all([
    doc.put({ TableName: table, Item: { PK: `RUN#${run.runId}`, SK: 'META', ...run, ttl } }),
    doc.put({
      TableName: table,
      Item: {
        PK: 'LIST',
        SK: `RUN#${run.createdAt}#${run.runId}`,
        runId: run.runId,
        job: run.job,
        source: run.source,
        createdAt: run.createdAt,
        lastStatus: run.lastStatus,
        exitCode: run.exitCode,
        durationMs: run.durationMs,
        ttl,
      },
    }),
  ]);
}
