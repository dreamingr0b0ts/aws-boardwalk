import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { ECSClient, RunTaskCommand, ListTasksCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs';
import { CloudWatchLogsClient, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { ECRClient, DescribeImagesCommand, DescribeImageScanFindingsCommand } from '@aws-sdk/client-ecr';
import { CodeBuildClient, ListBuildsForProjectCommand, BatchGetBuildsCommand } from '@aws-sdk/client-codebuild';
import { router, json, parseBody, requireOneOf, HttpError, type ApiEvent } from '../lib/http.js';
import { normalizeTask, saveRun } from '../lib/runs.js';

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
const SUBNETS: string[] = JSON.parse(process.env.SUBNETS_JSON!);
const SECURITY_GROUP = process.env.SECURITY_GROUP!;
const LOG_GROUP = process.env.LOG_GROUP!;
const ECR_REPO = process.env.ECR_REPO!;
const CODEBUILD_PROJECT = process.env.CODEBUILD_PROJECT!;
const DAILY_LIMIT = Number(process.env.GLOBAL_DAILY_LIMIT ?? '30');
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? '1');

const today = () => new Date().toISOString().slice(0, 10);

async function inflightTaskIds(): Promise<string[]> {
  // desiredStatus RUNNING covers PROVISIONING/PENDING/RUNNING — everything
  // that is or is about to be billing.
  const res = await ecs.send(new ListTasksCommand({ cluster: CLUSTER, desiredStatus: 'RUNNING' }));
  return (res.taskArns ?? []).map((a) => a.split('/').pop()!);
}

// Atomic global daily cap: the launch slot is claimed BEFORE RunTask, and the
// condition makes over-claiming impossible no matter how many Lambdas race.
async function claimDailySlot(): Promise<number> {
  try {
    const res = await doc.update({
      TableName: TABLE,
      Key: { PK: `USAGE#${today()}`, SK: 'GLOBAL' },
      UpdateExpression: 'ADD #n :one SET #ttl = if_not_exists(#ttl, :ttl)',
      ConditionExpression: 'attribute_not_exists(#n) OR #n < :limit',
      ExpressionAttributeNames: { '#n': 'launches', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':one': 1,
        ':limit': DAILY_LIMIT,
        ':ttl': Math.floor(Date.now() / 1000) + 72 * 3600,
      },
      ReturnValues: 'UPDATED_NEW',
    });
    return res.Attributes?.launches ?? 1;
  } catch (err: any) {
    if (err.name === 'ConditionalCheckFailedException') {
      throw new HttpError(429, `Daily launch limit reached (${DAILY_LIMIT}/day across all visitors); resets at 00:00 UTC`);
    }
    throw err;
  }
}

async function postRun(event: ApiEvent) {
  const { job } = parseBody<{ job?: string }>(event);
  requireOneOf(job, 'job', ['report', 'fail']);

  const inflight = await inflightTaskIds();
  if (inflight.length >= MAX_CONCURRENT) {
    return json(409, {
      message: 'A container is already running. Watch that one instead: one task at a time keeps this demo pocket-change.',
      runId: inflight[0],
    });
  }

  await claimDailySlot();

  const res = await ecs.send(
    new RunTaskCommand({
      cluster: CLUSTER,
      taskDefinition: TASK_FAMILY, // family name → latest ACTIVE revision
      launchType: 'FARGATE',
      count: 1,
      startedBy: `visitor:${job}`,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: SUBNETS,
          securityGroups: [SECURITY_GROUP],
          assignPublicIp: 'ENABLED', // public subnet + public IP = ECR pull without a NAT gateway
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: 'app',
            environment: [
              { name: 'JOB', value: job! },
              { name: 'SOURCE', value: 'visitor' },
            ],
          },
        ],
      },
    })
  );

  const failure = (res.failures ?? [])[0];
  if (failure || !res.tasks?.length) {
    console.error('RunTask failure', failure);
    throw new HttpError(502, `Fargate declined the launch: ${failure?.reason ?? 'unknown'}; try again in a minute`);
  }

  const run = normalizeTask(res.tasks[0])!;
  await saveRun(doc, TABLE, run);
  return json(202, { runId: run.runId, status: run.lastStatus });
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
    const fresh = res.tasks?.[0] ? normalizeTask(res.tasks[0]) : null;
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
    Limit: 14,
  });
  const runs = (res.Items ?? []).map((i) => ({ ...i, PK: undefined, SK: undefined, ttl: undefined }));
  return json(200, { runs });
}

async function getStatus() {
  const [image, scan, build, usage, inflight] = await Promise.all([
    ecr
      .send(new DescribeImagesCommand({ repositoryName: ECR_REPO, imageIds: [{ imageTag: 'latest' }] }))
      .then((r) => {
        const d = r.imageDetails?.[0];
        return d
          ? {
              digest: d.imageDigest,
              sizeBytes: d.imageSizeInBytes,
              pushedAt: d.imagePushedAt,
              tags: d.imageTags,
            }
          : null;
      })
      .catch((err) => (err.name === 'ImageNotFoundException' ? null : Promise.reject(err))),
    ecr
      .send(
        new DescribeImageScanFindingsCommand({ repositoryName: ECR_REPO, imageId: { imageTag: 'latest' } })
      )
      .then((r) => ({
        status: r.imageScanStatus?.status,
        completedAt: r.imageScanFindings?.imageScanCompletedAt,
        counts: r.imageScanFindings?.findingSeverityCounts ?? {},
      }))
      .catch((err) =>
        ['ScanNotFoundException', 'ImageNotFoundException'].includes(err.name) ? null : Promise.reject(err)
      ),
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
    lastBuild: build,
    usage,
    running: { count: inflight.length, taskIds: inflight, max: MAX_CONCURRENT },
  });
}

export const handler = router({
  'GET /api/status': getStatus,
  'GET /api/runs': listRuns,
  'GET /api/runs/{id}': getRun,
  'POST /api/runs': postRun,
});
