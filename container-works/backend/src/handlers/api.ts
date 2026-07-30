import { randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { ECSClient, RunTaskCommand, StopTaskCommand, ListTasksCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs';
import { CloudWatchLogsClient, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { ECRClient, DescribeImagesCommand, DescribeImageScanFindingsCommand } from '@aws-sdk/client-ecr';
import { CodeBuildClient, ListBuildsForProjectCommand, BatchGetBuildsCommand } from '@aws-sdk/client-codebuild';
import { router, json, parseBody, requireOneOf, HttpError, type ApiEvent } from '../lib/http.js';
import { normalizeTask, saveRun, pricesFromEnv, type RunRecord } from '../lib/runs.js';

const doc = DynamoDBDocument.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const ecs = new ECSClient({});
const logs = new CloudWatchLogsClient({});
const ecr = new ECRClient({});
const codebuild = new CodeBuildClient({});

const TABLE = process.env.TABLE_NAME!;
const CLUSTER = process.env.CLUSTER_ARN!;
const TASK_FAMILY = process.env.TASK_FAMILY!;
const TASK_FAMILY_BOOST = process.env.TASK_FAMILY_BOOST!;
const TASK_FAMILY_FAT = process.env.TASK_FAMILY_FAT!;
const SUBNETS: string[] = JSON.parse(process.env.SUBNETS_JSON!);
const SECURITY_GROUP = process.env.SECURITY_GROUP!;
const LOG_GROUP = process.env.LOG_GROUP!;
const ECR_REPO = process.env.ECR_REPO!;
const CODEBUILD_PROJECT = process.env.CODEBUILD_PROJECT!;
const DAILY_LIMIT = Number(process.env.GLOBAL_DAILY_LIMIT ?? '30');
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? '1');
const PRICES = pricesFromEnv();

const SINGLE_JOBS = ['report', 'fail', 'oom', 'drain', 'stubborn'];

// A race is one launch, two lanes, two daily slots. The lane job is identical
// in both ovens; only the task definition differs.
const RACES: Record<string, { kind: string; job: string; lanes: Array<{ family: string; variant: string }> }> = {
  'race-size': {
    kind: 'size',
    job: 'crunch',
    lanes: [
      { family: TASK_FAMILY, variant: 'standard' },
      { family: TASK_FAMILY_BOOST, variant: 'boost' },
    ],
  },
  'race-image': {
    kind: 'image',
    job: 'report',
    lanes: [
      { family: TASK_FAMILY, variant: 'standard' },
      { family: TASK_FAMILY_FAT, variant: 'fat' },
    ],
  },
};

const today = () => new Date().toISOString().slice(0, 10);

async function inflightTaskIds(): Promise<string[]> {
  // desiredStatus RUNNING covers PROVISIONING/PENDING/RUNNING — everything
  // that is or is about to be billing.
  const res = await ecs.send(new ListTasksCommand({ cluster: CLUSTER, desiredStatus: 'RUNNING' }));
  return (res.taskArns ?? []).map((a) => a.split('/').pop()!);
}

// Atomic global daily cap: launch slots are claimed BEFORE RunTask (a race
// claims two at once), and the condition makes over-claiming impossible no
// matter how many Lambdas race.
async function claimDailySlots(n: number): Promise<number> {
  try {
    const res = await doc.update({
      TableName: TABLE,
      Key: { PK: `USAGE#${today()}`, SK: 'GLOBAL' },
      UpdateExpression: 'ADD #n :n SET #ttl = if_not_exists(#ttl, :ttl)',
      ConditionExpression: 'attribute_not_exists(#n) OR #n <= :max',
      ExpressionAttributeNames: { '#n': 'launches', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':n': n,
        ':max': DAILY_LIMIT - n,
        ':ttl': Math.floor(Date.now() / 1000) + 72 * 3600,
      },
      ReturnValues: 'UPDATED_NEW',
    });
    return res.Attributes?.launches ?? n;
  } catch (err: any) {
    if (err.name === 'ConditionalCheckFailedException') {
      throw new HttpError(429, `Daily launch limit reached (${DAILY_LIMIT}/day across all visitors); resets at 00:00 UTC`);
    }
    throw err;
  }
}

interface LaunchSpec {
  family: string;
  job: string;
  variant: string;
  raceId?: string;
  raceKind?: string;
}

async function runTaskOnce(spec: LaunchSpec): Promise<RunRecord> {
  const environment = [
    { name: 'JOB', value: spec.job },
    { name: 'SOURCE', value: 'visitor' },
    { name: 'VARIANT', value: spec.variant },
  ];
  if (spec.raceId) {
    environment.push({ name: 'RACE_ID', value: spec.raceId }, { name: 'RACE_KIND', value: spec.raceKind! });
  }

  const res = await ecs.send(
    new RunTaskCommand({
      cluster: CLUSTER,
      taskDefinition: spec.family, // family name → latest ACTIVE revision
      launchType: 'FARGATE',
      count: 1,
      startedBy: spec.raceId ? `race:${spec.raceId}` : `visitor:${spec.job}`,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: SUBNETS,
          securityGroups: [SECURITY_GROUP],
          assignPublicIp: 'ENABLED', // public subnet + public IP = ECR pull without a NAT gateway
        },
      },
      overrides: { containerOverrides: [{ name: 'app', environment }] },
    })
  );

  const failure = (res.failures ?? [])[0];
  if (failure || !res.tasks?.length) {
    console.error('RunTask failure', failure);
    throw new HttpError(502, `Fargate declined the launch: ${failure?.reason ?? 'unknown'}; try again in a minute`);
  }
  return normalizeTask(res.tasks[0], PRICES)!;
}

// 409 hand-off: point the second visitor at whatever is in flight — a single
// run OR both lanes of a live race, so their page can attach to the race view.
async function inflightConflict(inflight: string[]) {
  try {
    const res = await ecs.send(new DescribeTasksCommand({ cluster: CLUSTER, tasks: inflight.slice(0, 2) }));
    const runs = (res.tasks ?? []).map((t) => normalizeTask(t, PRICES)).filter(Boolean) as RunRecord[];
    const first = runs[0];
    if (first?.raceId) {
      const lanes = runs
        .filter((r) => r.raceId === first.raceId)
        .map((r) => ({ runId: r.runId, variant: r.variant }));
      return json(409, {
        message: 'A bake-off is already in flight. Watch that one instead: the oven bay holds one launch at a time.',
        raceId: first.raceId,
        raceKind: first.raceKind,
        lanes,
      });
    }
  } catch (err) {
    console.warn('conflict describe failed, falling back to first id', err);
  }
  return json(409, {
    message: 'A container is already running. Watch that one instead: one launch at a time keeps this demo pocket-change.',
    runId: inflight[0],
  });
}

async function postRun(event: ApiEvent) {
  const { job } = parseBody<{ job?: string }>(event);
  requireOneOf(job, 'job', [...SINGLE_JOBS, ...Object.keys(RACES)]);

  const inflight = await inflightTaskIds();
  if (inflight.length >= MAX_CONCURRENT) return inflightConflict(inflight);

  const race = RACES[job!];
  if (!race) {
    await claimDailySlots(1);
    const run = await runTaskOnce({ family: TASK_FAMILY, job: job!, variant: 'standard' });
    await saveRun(doc, TABLE, run);
    return json(202, { runId: run.runId, status: run.lastStatus });
  }

  await claimDailySlots(race.lanes.length);
  const raceId = randomBytes(5).toString('hex');
  const launched: RunRecord[] = [];
  for (const lane of race.lanes) {
    try {
      launched.push(await runTaskOnce({ family: lane.family, job: race.job, variant: lane.variant, raceId, raceKind: race.kind }));
    } catch (err) {
      // A one-legged race is no exhibit: reel the first lane back in.
      if (launched.length) {
        await ecs
          .send(new StopTaskCommand({ cluster: CLUSTER, task: launched[0].runId, reason: 'race partner failed to launch' }))
          .catch((e) => console.error('failed to stop orphaned race lane', e));
      }
      throw err;
    }
  }
  await Promise.all(launched.map((run) => saveRun(doc, TABLE, run)));
  return json(202, {
    raceId,
    raceKind: race.kind,
    lanes: launched.map((r) => ({ runId: r.runId, variant: r.variant })),
  });
}

// The "pull the batch early" button: a real ecs:StopTask, which delivers
// SIGTERM, waits out the 30s stopTimeout, then SIGKILLs. The drain and
// stubborn jobs exist to show both endings.
async function postStop(event: ApiEvent) {
  const id = event.pathParameters?.id ?? '';
  if (!/^[a-f0-9]{32}$/.test(id)) throw new HttpError(400, 'Run ids are 32 hex characters (the ECS task id)');

  const res = await ecs.send(new DescribeTasksCommand({ cluster: CLUSTER, tasks: [id] }));
  const task = res.tasks?.[0];
  if (!task) throw new HttpError(404, 'No such task in flight (stopped tasks age out of DescribeTasks)');
  if (task.lastStatus === 'STOPPED' || task.desiredStatus === 'STOPPED') {
    throw new HttpError(409, 'That batch is already coming out of the oven');
  }

  await ecs.send(
    new StopTaskCommand({ cluster: CLUSTER, task: id, reason: 'Pulled early by a visitor (SIGTERM demo)' })
  );
  return json(202, { runId: id, message: 'SIGTERM sent; the 30s stopTimeout clock is running' });
}

async function getRun(event: ApiEvent) {
  const id = event.pathParameters?.id ?? '';
  if (!/^[a-f0-9]{32}$/.test(id)) throw new HttpError(400, 'Run ids are 32 hex characters (the ECS task id)');

  const meta = await doc.get({ TableName: TABLE, Key: { PK: `RUN#${id}`, SK: 'META' } });
  let run = meta.Item as any;
  if (!run) throw new HttpError(404, 'No such run (records expire after 48h)');

  // Refresh from ECS while the task is alive. Stopped tasks stay describable
  // for a few minutes only, so once STOPPED the DynamoDB record is the truth.
  if (run.lastStatus !== 'STOPPED') {
    const res = await ecs.send(new DescribeTasksCommand({ cluster: CLUSTER, tasks: [id] }));
    const fresh = res.tasks?.[0] ? normalizeTask(res.tasks[0], PRICES) : null;
    if (fresh) {
      run = { ...run, ...fresh };
      await saveRun(doc, TABLE, fresh);
    }
  }

  // Tail the container's own CloudWatch stream (awslogs driver): app/app/<task-id>
  let events: Array<{ t: number; m: string }> = [];
  let nextToken: string | undefined = event.queryStringParameters?.nextToken;
  try {
    const res = await logs.send(
      new GetLogEventsCommand({
        logGroupName: LOG_GROUP,
        logStreamName: `app/app/${id}`,
        startFromHead: true,
        nextToken,
        limit: 250,
      })
    );
    events = (res.events ?? []).map((e) => ({ t: e.timestamp ?? 0, m: (e.message ?? '').trimEnd() }));
    nextToken = res.nextForwardToken ?? nextToken;
  } catch (err: any) {
    if (err.name !== 'ResourceNotFoundException') throw err; // stream appears once the container boots
  }

  const artifact =
    run.job === 'report' && run.exitCode === 0 ? `/artifacts/${id}.html` : undefined;

  return json(200, { run: { ...run, PK: undefined, SK: undefined, ttl: undefined }, logs: events, nextToken, artifact });
}

async function listRuns() {
  const res = await doc.query({
    TableName: TABLE,
    KeyConditionExpression: 'PK = :list',
    ExpressionAttributeValues: { ':list': 'LIST' },
    ScanIndexForward: false,
    Limit: 16,
  });
  const runs = (res.Items ?? []).map((i) => ({ ...i, PK: undefined, SK: undefined, ttl: undefined }));
  return json(200, { runs });
}

async function describeImage(tag: string) {
  return ecr
    .send(new DescribeImagesCommand({ repositoryName: ECR_REPO, imageIds: [{ imageTag: tag }] }))
    .then((r) => {
      const d = r.imageDetails?.[0];
      return d
        ? { digest: d.imageDigest, sizeBytes: d.imageSizeInBytes, pushedAt: d.imagePushedAt, tags: d.imageTags }
        : null;
    })
    .catch((err) => (err.name === 'ImageNotFoundException' ? null : Promise.reject(err)));
}

async function describeScan(tag: string) {
  return ecr
    .send(new DescribeImageScanFindingsCommand({ repositoryName: ECR_REPO, imageId: { imageTag: tag } }))
    .then((r) => ({
      status: r.imageScanStatus?.status,
      completedAt: r.imageScanFindings?.imageScanCompletedAt,
      counts: r.imageScanFindings?.findingSeverityCounts ?? {},
    }))
    .catch((err) =>
      ['ScanNotFoundException', 'ImageNotFoundException'].includes(err.name) ? null : Promise.reject(err)
    );
}

async function getStatus() {
  const [image, scan, imageFat, scanFat, build, usage, inflight] = await Promise.all([
    describeImage('latest'),
    describeScan('latest'),
    describeImage('fat'),
    describeScan('fat'),
    codebuild
      .send(new ListBuildsForProjectCommand({ projectName: CODEBUILD_PROJECT, sortOrder: 'DESCENDING' }))
      .then(async (r) => {
        const id = r.ids?.[0];
        if (!id) return null;
        const b = (await codebuild.send(new BatchGetBuildsCommand({ ids: [id] }))).builds?.[0];
        return b
          ? {
              number: b.buildNumber,
              status: b.buildStatus,
              startTime: b.startTime,
              endTime: b.endTime,
            }
          : null;
      }),
    doc
      .get({ TableName: TABLE, Key: { PK: `USAGE#${today()}`, SK: 'GLOBAL' } })
      .then((r) => ({ used: r.Item?.launches ?? 0, limit: DAILY_LIMIT })),
    inflightTaskIds(),
  ]);

  return json(200, {
    image,
    scan,
    imageFat,
    scanFat,
    lastBuild: build,
    usage,
    prices: PRICES, // the receipt rates, so the dashboard's live meter can tick
    running: { count: inflight.length, taskIds: inflight, max: MAX_CONCURRENT },
  });
}

export const handler = router({
  'GET /api/status': getStatus,
  'GET /api/runs': listRuns,
  'GET /api/runs/{id}': getRun,
  'POST /api/runs': postRun,
  'POST /api/runs/{id}/stop': postStop,
});
