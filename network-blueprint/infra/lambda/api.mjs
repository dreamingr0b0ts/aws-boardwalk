// Inspection API for the drafting-room plank. Visitors trigger a live field
// inspection round: SSM Run Command probes executed one at a time on both
// instances, then compared against the Reachability Analyzer verdicts. The
// heavy work happens in the net-inspection-runner Lambda (invoked async);
// this function only gates and reads.
//
// The demo stack is discovered through SSM parameters the demo root writes.
// Between demo windows the parameters are gone and POST answers honestly
// with 503. Guardrails: a one-round-at-a-time lock (extra POSTs get a 409
// pointing at the round already under way, so visitors share the live view)
// and an atomic global daily counter (429 once the day's rounds are spent).
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { SSMClient, GetParametersCommand, DescribeInstanceInformationCommand } from "@aws-sdk/client-ssm";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { randomUUID } from "node:crypto";

const { TABLE_NAME, SSM_PREFIX, RUNNER_FUNCTION } = process.env;
const DAILY_LIMIT = Number(process.env.GLOBAL_DAILY_LIMIT ?? "30");
const LOCK_SECONDS = 300; // a wedged runner can hold the site this long at most

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const ssm = new SSMClient({});
const lambda = new LambdaClient({});

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const today = () => new Date().toISOString().slice(0, 10);
const nowS = () => Math.floor(Date.now() / 1000);

// ---- demo-stack discovery (SSM, cached briefly) -----------------------------

let stackCache = { at: 0, value: null };

async function demoStack() {
  if (Date.now() - stackCache.at < 30_000) return stackCache.value;
  const names = ["public-instance-id", "private-instance-id", "private-app-ip", "analyses"]
    .map((n) => `${SSM_PREFIX}/${n}`);
  const res = await ssm.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
  const get = (n) => res.Parameters?.find((p) => p.Name.endsWith(`/${n}`))?.Value;
  const value = res.Parameters?.length === names.length
    ? {
        publicInstanceId: get("public-instance-id"),
        privateInstanceId: get("private-instance-id"),
        privateAppIp: get("private-app-ip"),
        analyses: JSON.parse(get("analyses")),
      }
    : null;
  stackCache = { at: Date.now(), value };
  return value;
}

// ---- guardrails --------------------------------------------------------------

async function currentLock() {
  const res = await doc.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: "LOCK", SK: "GLOBAL" } }));
  const lock = res.Item;
  return lock && lock.lockUntil > nowS() ? lock : null;
}

// One inspector on the site at a time. The claim is conditional so racing
// Lambdas cannot both hold it; a stale lock (crashed runner) expires on its
// own after LOCK_SECONDS.
async function claimLock(runId) {
  try {
    await doc.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: "LOCK", SK: "GLOBAL" },
      UpdateExpression: "SET runId = :id, lockUntil = :until, startedAt = :at",
      ConditionExpression: "attribute_not_exists(lockUntil) OR lockUntil < :now",
      ExpressionAttributeValues: {
        ":id": runId,
        ":until": nowS() + LOCK_SECONDS,
        ":at": new Date().toISOString(),
        ":now": nowS(),
      },
    }));
    return { ok: true };
  } catch (err) {
    if (err.name !== "ConditionalCheckFailedException") throw err;
    return { ok: false, runId: (await currentLock())?.runId ?? null };
  }
}

async function releaseLock(runId) {
  await doc.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: "LOCK", SK: "GLOBAL" },
    UpdateExpression: "SET lockUntil = :zero",
    ConditionExpression: "runId = :id",
    ExpressionAttributeValues: { ":zero": 0, ":id": runId },
  })).catch(() => {});
}

// Atomic global daily cap: the slot is claimed BEFORE the runner is invoked,
// and the condition makes over-claiming impossible no matter how many
// Lambdas race.
async function claimDailySlot() {
  try {
    const res = await doc.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `USAGE#${today()}`, SK: "GLOBAL" },
      UpdateExpression: "ADD #n :one SET #ttl = if_not_exists(#ttl, :ttl)",
      ConditionExpression: "attribute_not_exists(#n) OR #n < :limit",
      ExpressionAttributeNames: { "#n": "rounds", "#ttl": "ttl" },
      ExpressionAttributeValues: { ":one": 1, ":limit": DAILY_LIMIT, ":ttl": nowS() + 72 * 3600 },
      ReturnValues: "UPDATED_NEW",
    }));
    return res.Attributes?.rounds ?? 1;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return null;
    throw err;
  }
}

// ---- routes ------------------------------------------------------------------

async function getStatus() {
  const [stack, usageRes, lock] = await Promise.all([
    demoStack(),
    doc.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `USAGE#${today()}`, SK: "GLOBAL" } })),
    currentLock(),
  ]);
  return json(200, {
    deployed: Boolean(stack),
    usage: { used: usageRes.Item?.rounds ?? 0, limit: DAILY_LIMIT },
    running: lock ? { runId: lock.runId, startedAt: lock.startedAt } : null,
  });
}

// Both instances must be Online in SSM before a round can go out. The private
// one registers over the PrivateLink endpoints and takes a few minutes after
// deploy — a round dispatched before that would walk into a half-built site.
async function ssmReady(stack) {
  const res = await ssm.send(new DescribeInstanceInformationCommand({
    Filters: [{ Key: "InstanceIds", Values: [stack.publicInstanceId, stack.privateInstanceId] }],
  }));
  return (res.InstanceInformationList ?? []).filter((i) => i.PingStatus === "Online").length === 2;
}

async function postRun() {
  const stack = await demoStack();
  if (!stack) {
    return json(503, {
      message:
        "The demo stack is struck between windows, so there is no site to walk right now. " +
        "The as-built record below is the latest completed evidence.",
    });
  }
  if (!(await ssmReady(stack))) {
    return json(503, {
      message:
        "The site is still being staked out: the instances have not finished registering with " +
        "SSM (the private one comes up over PrivateLink and takes a few minutes). Try again shortly.",
    });
  }

  const runId = `insp-${randomUUID().replaceAll("-", "").slice(0, 8)}`;

  // Two attempts: if the first claim loses to a lock that expires before we
  // can read it, one retry settles it instead of dispatching lock-less.
  let claimed = false;
  let inflightId = null;
  for (let attempt = 0; attempt < 2 && !claimed; attempt += 1) {
    const res = await claimLock(runId);
    if (res.ok) claimed = true;
    else if (res.runId) { inflightId = res.runId; break; }
  }
  if (!claimed) {
    return json(409, {
      message:
        "An inspection round is already out on the site. One inspector at a time; " +
        "you are watching the round that is under way.",
      ...(inflightId ? { runId: inflightId } : {}),
    });
  }

  try {
    const round = await claimDailySlot();
    if (round === null) {
      await releaseLock(runId);
      return json(429, {
        message: `The day book is full: ${DAILY_LIMIT} rounds per UTC day across all visitors. It resets at 00:00 UTC.`,
      });
    }

    const createdAt = new Date().toISOString();
    const ttl = nowS() + 48 * 3600;
    const run = {
      runId,
      source: "visitor",
      status: "queued",
      createdAt,
      round,
      roundLimit: DAILY_LIMIT,
      probes: [],
      plan: null,
      log: [{ t: Date.now(), m: `[dispatch] work order ${runId} accepted · round ${round} of ${DAILY_LIMIT} today` }],
    };
    await Promise.all([
      doc.send(new PutCommand({ TableName: TABLE_NAME, Item: { PK: `RUN#${runId}`, SK: "META", ...run, ttl } })),
      doc.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: { PK: "LIST", SK: `RUN#${createdAt}#${runId}`, runId, createdAt, status: "queued", source: "visitor", ttl },
      })),
    ]);

    try {
      await lambda.send(new InvokeCommand({
        FunctionName: RUNNER_FUNCTION,
        InvocationType: "Event",
        Payload: JSON.stringify({ runId, createdAt }),
      }));
    } catch (err) {
      console.error("runner invoke failed", err);
      await releaseLock(runId);
      return json(502, { message: "The inspection runner could not be dispatched; try again in a minute." });
    }

    return json(202, { runId, round, limit: DAILY_LIMIT });
  } catch (err) {
    await releaseLock(runId);
    throw err;
  }
}

async function getRun(event) {
  const id = event.pathParameters?.id ?? "";
  if (!/^insp-[a-f0-9]{8}$/.test(id)) {
    return json(400, { message: "Round ids look like insp-1a2b3c4d" });
  }
  const res = await doc.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `RUN#${id}`, SK: "META" } }));
  if (!res.Item) return json(404, { message: "No such round (records expire after 48h)" });
  const { PK, SK, ttl, ...run } = res.Item;
  return json(200, { run });
}

async function listRuns() {
  const res = await doc.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "PK = :list",
    ExpressionAttributeValues: { ":list": "LIST" },
    ScanIndexForward: false,
    Limit: 14,
  }));
  const runs = (res.Items ?? []).map(({ PK, SK, ttl, ...r }) => r);
  return json(200, { runs });
}

const routes = {
  "GET /api/status": getStatus,
  "GET /api/runs": listRuns,
  "GET /api/runs/{id}": getRun,
  "POST /api/runs": postRun,
};

export const handler = async (event) => {
  try {
    const fn = routes[event.routeKey];
    if (!fn) return json(404, { message: "Not found" });
    return await fn(event);
  } catch (err) {
    console.error("unhandled", err);
    return json(500, { message: "Internal error" });
  }
};
