import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

// One normalized shape for every source of task state: the RunTask response
// (POST /api/runs), DescribeTasks (GET polling), and EventBridge ECS
// task-state-change events (finalize) all produce the same task object modulo
// Date-vs-ISO-string timestamps.

export interface RunCost {
  vcpuUsd: number;
  memUsd: number;
  ipUsd: number;
  totalUsd: number;
}

export interface RunRecord {
  runId: string;
  job: string;
  source: string;
  variant: string; // standard | boost | fat (task-definition sizing/image lane)
  raceId?: string;
  raceKind?: string; // size | image
  lastStatus: string;
  cpu?: number; // vCPU units (256 = 0.25 vCPU)
  memMiB?: number;
  createdAt: string;
  connectivityAt?: string;
  pullStartedAt?: string;
  pullStoppedAt?: string;
  startedAt?: string;
  stoppingAt?: string;
  executionStoppedAt?: string;
  stoppedAt?: string;
  exitCode?: number;
  stoppedReason?: string;
  containerReason?: string; // where Fargate puts "OutOfMemoryError: ..."
  durationMs?: number; // startedAt → stoppedAt (the container's life)
  pullMs?: number; // pullStartedAt → pullStoppedAt (the image race decider)
  appMs?: number; // startedAt → executionStoppedAt (the sizing race decider)
  billedMs?: number; // pullStartedAt → stoppedAt (Fargate's billing window)
  cost?: RunCost;
}

export interface Prices {
  vcpuHour: number;
  gbHour: number;
  pubIpHour: number;
}

/** Read the receipt rates both Lambdas get from Terraform. */
export function pricesFromEnv(): Prices | undefined {
  const vcpuHour = Number(process.env.PRICE_VCPU_HOUR ?? '');
  const gbHour = Number(process.env.PRICE_GB_HOUR ?? '');
  const pubIpHour = Number(process.env.PRICE_PUBIP_HOUR ?? '');
  if (!vcpuHour || !gbHour) return undefined;
  return { vcpuHour, gbHour, pubIpHour: pubIpHour || 0 };
}

const TTL_HOURS = 48;

const round7 = (n: number) => Math.round(n * 1e7) / 1e7;

export function normalizeTask(task: Record<string, any>, prices?: Prices): RunRecord | null {
  const taskArn: string | undefined = task?.taskArn;
  if (!taskArn) return null;

  const iso = (v: unknown): string | undefined => (v ? new Date(v as string).toISOString() : undefined);
  const ms = (a?: string, b?: string): number | undefined =>
    a && b ? new Date(b).getTime() - new Date(a).getTime() : undefined;
  const env: Array<{ name: string; value: string }> =
    task.overrides?.containerOverrides?.find((c: any) => c.name === 'app')?.environment ?? [];
  const fromEnv = (name: string) => env.find((e) => e.name === name)?.value;

  // Lane fallback for launches that skip the API (the daily schedule): the
  // task-definition family suffix says which oven this was.
  const family: string = (task.taskDefinitionArn ?? '').split('/').pop()?.split(':')[0] ?? '';
  const familyVariant = family.endsWith('-boost') ? 'boost' : family.endsWith('-fat') ? 'fat' : 'standard';

  const createdAt = iso(task.createdAt) ?? new Date().toISOString();
  const pullStartedAt = iso(task.pullStartedAt);
  const pullStoppedAt = iso(task.pullStoppedAt);
  const startedAt = iso(task.startedAt);
  const executionStoppedAt = iso(task.executionStoppedAt);
  const stoppedAt = iso(task.stoppedAt);
  const container = (task.containers ?? [])[0];
  const cpu = task.cpu ? Number(task.cpu) : undefined;
  const memMiB = task.memory ? Number(task.memory) : undefined;

  const billedMs = ms(pullStartedAt, stoppedAt);

  // The bake ticket: Fargate bills vCPU + GB from the start of the image pull
  // to task stop; the public IPv4 meter runs roughly the task's whole life.
  let cost: RunCost | undefined;
  if (prices && billedMs !== undefined && cpu && memMiB) {
    const billedHours = billedMs / 3.6e6;
    const ipHours = (ms(createdAt, stoppedAt) ?? billedMs) / 3.6e6;
    const vcpuUsd = (cpu / 1024) * billedHours * prices.vcpuHour;
    const memUsd = (memMiB / 1024) * billedHours * prices.gbHour;
    const ipUsd = ipHours * prices.pubIpHour;
    cost = {
      vcpuUsd: round7(vcpuUsd),
      memUsd: round7(memUsd),
      ipUsd: round7(ipUsd),
      totalUsd: round7(vcpuUsd + memUsd + ipUsd),
    };
  }

  return {
    runId: taskArn.split('/').pop()!,
    job: fromEnv('JOB') ?? 'report',
    source: fromEnv('SOURCE') ?? 'schedule', // the daily schedule is the only launcher that skips the API
    variant: fromEnv('VARIANT') ?? familyVariant,
    raceId: fromEnv('RACE_ID'),
    raceKind: fromEnv('RACE_KIND'),
    lastStatus: task.lastStatus ?? 'PROVISIONING',
    cpu,
    memMiB,
    createdAt,
    connectivityAt: iso(task.connectivityAt),
    pullStartedAt,
    pullStoppedAt,
    startedAt,
    stoppingAt: iso(task.stoppingAt),
    executionStoppedAt,
    stoppedAt,
    exitCode: typeof container?.exitCode === 'number' ? container.exitCode : undefined,
    stoppedReason: task.stoppedReason || undefined,
    containerReason: container?.reason || undefined,
    durationMs: ms(startedAt, stoppedAt),
    pullMs: ms(pullStartedAt, pullStoppedAt),
    appMs: ms(startedAt, executionStoppedAt) ?? ms(startedAt, stoppedAt),
    billedMs,
    cost,
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
        variant: run.variant,
        raceId: run.raceId,
        raceKind: run.raceKind,
        createdAt: run.createdAt,
        lastStatus: run.lastStatus,
        exitCode: run.exitCode,
        durationMs: run.durationMs,
        pullMs: run.pullMs,
        appMs: run.appMs,
        costUsd: run.cost?.totalUsd,
        ttl,
      },
    }),
  ]);
}
