// Live-exhibit API for the ops plank. Four exhibits, one gatekeeper:
//
//   drill  - starts the REAL backup/restore Step Functions drill and turns its
//            execution history into a stage timeline the page can watch
//   sweep  - dispatches the closing-sweep runner (async Lambda) over every
//            live boardwalk site
//   ci     - recent pipeline runs, proxied and shaped from the GitHub API
//   cost   - month-to-date spend per plank from Cost Explorer, memoized a day
//
// Guardrails mirror planks 4/9: one drill and one sweep at a time (extra
// POSTs get a 409 carrying the run under way, so visitors attach to the live
// view), atomic global daily counters, and no visitor input reaches anything
// (both POST bodies are ignored entirely).
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  SFNClient, StartExecutionCommand, DescribeExecutionCommand, GetExecutionHistoryCommand,
} from "@aws-sdk/client-sfn";
import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { randomUUID } from "node:crypto";

const { TABLE_NAME, SFN_ARN, RUNNER_FUNCTION, GITHUB_REPO } = process.env;
const SITES = JSON.parse(process.env.SITES ?? "[]");
const DRILL_LIMIT = Number(process.env.DRILL_DAILY_LIMIT ?? "10");
const SWEEP_LIMIT = Number(process.env.SWEEP_DAILY_LIMIT ?? "30");
const COST_EXCLUDE = (process.env.COST_EXCLUDE_SERVICES ?? "").split(",").filter(Boolean);

const DRILL_LOCK_SECONDS = 900; // a drill runs ~5 min; a wedged one frees itself here
const SWEEP_LOCK_SECONDS = 180;
const CI_MEMO_MS = 5 * 60 * 1000;
const COST_MEMO_MS = 24 * 3600 * 1000; // Cost Explorer bills $0.01/call and lags ~a day

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const sfn = new SFNClient({});
const ce = new CostExplorerClient({});
const lambda = new LambdaClient({});

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const today = () => new Date().toISOString().slice(0, 10);
const nowS = () => Math.floor(Date.now() / 1000);

// ---- shared guardrails -------------------------------------------------------

async function currentLock(kind) {
  const res = await doc.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: "LOCK", SK: kind } }));
  return res.Item && res.Item.lockUntil > nowS() ? res.Item : null;
}

async function claimLock(kind, runId, seconds) {
  try {
    await doc.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: "LOCK", SK: kind },
      UpdateExpression: "SET runId = :id, lockUntil = :until, startedAt = :at",
      ConditionExpression: "attribute_not_exists(lockUntil) OR lockUntil < :now",
      ExpressionAttributeValues: {
        ":id": runId, ":until": nowS() + seconds,
        ":at": new Date().toISOString(), ":now": nowS(),
      },
    }));
    return { ok: true };
  } catch (err) {
    if (err.name !== "ConditionalCheckFailedException") throw err;
    return { ok: false, runId: (await currentLock(kind))?.runId ?? null };
  }
}

async function releaseLock(kind, runId) {
  await doc.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: "LOCK", SK: kind },
    UpdateExpression: "SET lockUntil = :zero",
    ConditionExpression: "runId = :id",
    ExpressionAttributeValues: { ":zero": 0, ":id": runId },
  })).catch((err) => {
    // A lost condition just means a newer run holds the lock; anything else
    // is a real bug and must be visible (plank 3 lesson: never swallow).
    if (err.name !== "ConditionalCheckFailedException") console.error("releaseLock", kind, err);
  });
}

// Atomic daily cap: the slot is claimed BEFORE dispatch, and the condition
// makes over-claiming impossible no matter how many Lambdas race.
async function claimDailySlot(counter, limit) {
  try {
    const res = await doc.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `USAGE#${today()}`, SK: "GLOBAL" },
      UpdateExpression: "ADD #n :one SET #ttl = if_not_exists(#ttl, :ttl)",
      ConditionExpression: "attribute_not_exists(#n) OR #n < :limit",
      ExpressionAttributeNames: { "#n": counter, "#ttl": "ttl" },
      ExpressionAttributeValues: { ":one": 1, ":limit": limit, ":ttl": nowS() + 72 * 3600 },
      ReturnValues: "UPDATED_NEW",
    }));
    return res.Attributes?.[counter] ?? 1;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return null;
    throw err;
  }
}

// ---- GET /api/status ---------------------------------------------------------

async function getStatus() {
  const [usage, drillLock, sweepLock] = await Promise.all([
    doc.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `USAGE#${today()}`, SK: "GLOBAL" } })),
    currentLock("DRILL"),
    currentLock("SWEEP"),
  ]);
  return json(200, {
    drill: {
      used: usage.Item?.drills ?? 0, limit: DRILL_LIMIT,
      running: drillLock ? { runId: drillLock.runId, startedAt: drillLock.startedAt } : null,
    },
    sweep: {
      used: usage.Item?.sweeps ?? 0, limit: SWEEP_LIMIT,
      running: sweepLock ? { runId: sweepLock.runId, startedAt: sweepLock.startedAt } : null,
    },
    sites: SITES.length,
  });
}

// ---- the beacon drill --------------------------------------------------------

async function postDrill() {
  const runId = `drl-${randomUUID().replaceAll("-", "").slice(0, 8)}`;

  let claimed = false;
  let inflightId = null;
  for (let attempt = 0; attempt < 2 && !claimed; attempt += 1) {
    const res = await claimLock("DRILL", runId, DRILL_LOCK_SECONDS);
    if (res.ok) claimed = true;
    else if (res.runId) { inflightId = res.runId; break; }
  }
  if (!claimed) {
    return json(409, {
      message: "A beacon drill is already under way. One drill at a time; you are watching the one in progress.",
      ...(inflightId ? { runId: inflightId } : {}),
    });
  }

  try {
    const slot = await claimDailySlot("drills", DRILL_LIMIT);
    if (slot === null) {
      await releaseLock("DRILL", runId);
      return json(429, {
        message: `The day book is full: ${DRILL_LIMIT} drills per UTC day across all visitors. It resets at 00:00 UTC.`,
      });
    }

    const exec = await sfn.send(new StartExecutionCommand({
      stateMachineArn: SFN_ARN,
      name: `web-${runId}`,
    }));

    const createdAt = new Date().toISOString();
    await doc.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `RUN#${runId}`, SK: "META",
        kind: "drill", runId, executionArn: exec.executionArn,
        status: "running", createdAt, slot, ttl: nowS() + 48 * 3600,
      },
    }));

    return json(202, { runId, slot, limit: DRILL_LIMIT });
  } catch (err) {
    await releaseLock("DRILL", runId);
    throw err;
  }
}

// The drill state machine's states, folded into the four stops the page
// draws. Wait/Choice polling states belong to the stage they poll for.
const STAGES = [
  { key: "snapshot", label: "Bury the beacon", enter: "CreateBackup" },
  { key: "restore", label: "Probe line", enter: "RestoreTable" },
  { key: "verify", label: "Strike", enter: "VerifyAndReport" },
  { key: "cleanup", label: "Pack out", enter: ["CleanupDrillTable", "CleanupBackupAfterFailure"] },
];

async function getDrill(event) {
  const id = event.pathParameters?.id ?? "";
  if (!/^drl-[a-f0-9]{8}$/.test(id)) return json(400, { message: "Drill ids look like drl-1a2b3c4d" });

  const res = await doc.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `RUN#${id}`, SK: "META" } }));
  if (!res.Item) return json(404, { message: "No such drill (records expire after 48h)" });
  const run = res.Item;

  const [exec, hist] = await Promise.all([
    sfn.send(new DescribeExecutionCommand({ executionArn: run.executionArn })),
    sfn.send(new GetExecutionHistoryCommand({ executionArn: run.executionArn, maxResults: 1000 })),
  ]);

  const entered = {};
  for (const ev of hist.events ?? []) {
    const name = ev.stateEnteredEventDetails?.name;
    if (name && !entered[name]) entered[name] = ev.timestamp;
  }

  const terminal = exec.status !== "RUNNING";
  const failed = exec.status === "FAILED" || exec.status === "TIMED_OUT" || exec.status === "ABORTED";
  const startFor = (s) => [s.enter].flat().map((n) => entered[n]).find(Boolean) ?? null;

  const stages = STAGES.map((s, i) => {
    const startedAt = startFor(s);
    const next = STAGES[i + 1];
    const endedAt = startedAt
      ? (next && startFor(next)) ?? (terminal ? exec.stopDate : null)
      : null;
    let status = "pending";
    if (startedAt) status = endedAt ? "done" : "active";
    return { key: s.key, label: s.label, status, startedAt, endedAt };
  });
  // On failure, the last stage that got under way wears the result.
  if (failed) {
    const last = [...stages].reverse().find((s) => s.status !== "pending");
    if (last) last.status = "failed";
  }

  let report = null;
  if (exec.status === "SUCCEEDED" && exec.output) {
    try { report = JSON.parse(exec.output)?.verify?.report ?? null; } catch { /* raw output stays private */ }
  }

  if (terminal && run.status === "running") {
    await doc.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `RUN#${id}`, SK: "META" },
      UpdateExpression: "SET #s = :s",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": failed ? "failed" : "done" },
    }));
    await releaseLock("DRILL", id);
  }

  return json(200, {
    runId: id,
    execution: exec.name,
    status: exec.status,
    startedAt: exec.startDate,
    stoppedAt: terminal ? exec.stopDate : null,
    stages,
    report,
  });
}

// ---- the closing sweep -------------------------------------------------------

async function postSweep() {
  const runId = `swp-${randomUUID().replaceAll("-", "").slice(0, 8)}`;

  let claimed = false;
  let inflightId = null;
  for (let attempt = 0; attempt < 2 && !claimed; attempt += 1) {
    const res = await claimLock("SWEEP", runId, SWEEP_LOCK_SECONDS);
    if (res.ok) claimed = true;
    else if (res.runId) { inflightId = res.runId; break; }
  }
  if (!claimed) {
    return json(409, {
      message: "Patrol is already out on the closing sweep. You are watching the sweep under way.",
      ...(inflightId ? { runId: inflightId } : {}),
    });
  }

  try {
    const slot = await claimDailySlot("sweeps", SWEEP_LIMIT);
    if (slot === null) {
      await releaseLock("SWEEP", runId);
      return json(429, {
        message: `The day book is full: ${SWEEP_LIMIT} sweeps per UTC day across all visitors. It resets at 00:00 UTC.`,
      });
    }

    const createdAt = new Date().toISOString();
    await doc.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `RUN#${runId}`, SK: "META",
        kind: "sweep", runId, status: "running", createdAt, slot,
        checks: SITES.map((s) => ({ ...s, status: "pending" })),
        ttl: nowS() + 48 * 3600,
      },
    }));

    try {
      await lambda.send(new InvokeCommand({
        FunctionName: RUNNER_FUNCTION,
        InvocationType: "Event",
        Payload: JSON.stringify({ runId, sites: SITES }),
      }));
    } catch (err) {
      console.error("sweep runner invoke failed", err);
      await releaseLock("SWEEP", runId);
      return json(502, { message: "Patrol could not be dispatched; try again in a minute." });
    }

    return json(202, { runId, slot, limit: SWEEP_LIMIT });
  } catch (err) {
    await releaseLock("SWEEP", runId);
    throw err;
  }
}

async function getSweep(event) {
  const id = event.pathParameters?.id ?? "";
  if (!/^swp-[a-f0-9]{8}$/.test(id)) return json(400, { message: "Sweep ids look like swp-1a2b3c4d" });
  const res = await doc.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `RUN#${id}`, SK: "META" } }));
  if (!res.Item) return json(404, { message: "No such sweep (records expire after 48h)" });
  const { PK, SK, ttl, executionArn, ...run } = res.Item;
  return json(200, run);
}

// ---- the sweep log (GitHub Actions, proxied + shaped) ------------------------

let ciMemo = { at: 0, payload: null };

async function gh(path) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      signal: ctl.signal,
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "boardwalk-ops-exhibit",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!res.ok) throw new Error(`github ${res.status} on ${path}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

const shapeRun = (r) => ({
  id: r.id,
  event: r.event,
  sha: (r.head_sha ?? "").slice(0, 7),
  message: (r.head_commit?.message ?? "").split("\n")[0].slice(0, 90),
  status: r.status,
  conclusion: r.conclusion,
  startedAt: r.run_started_at,
  durationS: r.status === "completed"
    ? Math.max(0, Math.round((new Date(r.updated_at) - new Date(r.run_started_at)) / 1000))
    : null,
  url: r.html_url,
});

async function getCi() {
  if (Date.now() - ciMemo.at < CI_MEMO_MS && ciMemo.payload) return json(200, ciMemo.payload);

  try {
    const [runsRes, sweepRes] = await Promise.all([
      gh(`/repos/${GITHUB_REPO}/actions/workflows/terraform.yml/runs?branch=main&per_page=10`),
      gh(`/repos/${GITHUB_REPO}/actions/workflows/demo-sweep.yml/runs?per_page=1`),
    ]);
    const runs = (runsRes.workflow_runs ?? []).map(shapeRun);

    // Legs of the most recent run: the matrix collapses to three chips.
    let legs = null;
    if (runs[0]) {
      const jobsRes = await gh(`/repos/${GITHUB_REPO}/actions/runs/${runs[0].id}/jobs?per_page=100`);
      const jobs = jobsRes.jobs ?? [];
      const bucket = (prefix) => {
        const of = jobs.filter((j) => j.name.startsWith(prefix));
        return { ok: of.filter((j) => j.conclusion === "success").length, total: of.length };
      };
      legs = { scan: bucket("security scan"), plan: bucket("plan ("), apply: bucket("apply (") };
    }

    const overnight = (sweepRes.workflow_runs ?? []).map(shapeRun)[0] ?? null;
    const payload = { fetchedAt: new Date().toISOString(), stale: false, runs, legs, overnight };
    ciMemo = { at: Date.now(), payload };
    doc.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: { PK: "CI", SK: "LATEST", payload: JSON.stringify(payload) },
    })).catch((err) => console.error("ci cache write", err));
    return json(200, payload);
  } catch (err) {
    // Rate-limited or unreachable: serve the last good board, marked stale.
    console.error("github fetch failed", err);
    const cached = await doc.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: "CI", SK: "LATEST" } }));
    if (cached.Item?.payload) {
      const payload = { ...JSON.parse(cached.Item.payload), stale: true };
      return json(200, payload);
    }
    return json(503, { message: "The sweep log is briefly unavailable (GitHub API); try again in a minute." });
  }
}

// ---- the season ledger (Cost Explorer, memoized a day) -----------------------

const CE_FILTER = {
  And: [
    { Not: { Dimensions: { Key: "RECORD_TYPE", Values: ["Credit", "Refund"] } } },
    { Not: { Dimensions: { Key: "SERVICE", Values: COST_EXCLUDE } } },
  ],
};

const usd = (g) => Number(g.Metrics?.UnblendedCost?.Amount ?? "0");

async function refreshCost() {
  const now = new Date();
  const monthStart = `${now.toISOString().slice(0, 8)}01`;
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const base = {
    TimePeriod: { Start: monthStart, End: tomorrow },
    Granularity: "MONTHLY",
    Metrics: ["UnblendedCost"],
    Filter: CE_FILTER,
  };

  const [byEnvRes, bySvcRes] = await Promise.all([
    ce.send(new GetCostAndUsageCommand({ ...base, GroupBy: [{ Type: "TAG", Key: "env" }] })),
    ce.send(new GetCostAndUsageCommand({ ...base, GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }] })),
  ]);

  const envGroups = byEnvRes.ResultsByTime?.[0]?.Groups ?? [];
  const svcGroups = bySvcRes.ResultsByTime?.[0]?.Groups ?? [];

  const byEnv = envGroups
    .map((g) => ({ env: (g.Keys?.[0] ?? "").replace(/^env\$/, ""), usd: usd(g) }))
    .filter((e) => e.usd >= 0.005 || e.env !== "")
    .sort((a, b) => b.usd - a.usd);
  const byService = svcGroups
    .map((g) => ({ service: g.Keys?.[0] ?? "", usd: usd(g) }))
    .filter((s) => s.usd >= 0.005)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 12);
  const total = svcGroups.reduce((sum, g) => sum + usd(g), 0);
  // Tagged attribution only lands after the cost allocation tag backfill
  // finishes; until then everything sits in the empty-tag bucket.
  const envReady = byEnv.some((e) => e.env !== "" && e.usd > 0);

  return {
    asOf: now.toISOString(),
    monthStart,
    total: Math.round(total * 100) / 100,
    byEnv,
    byService,
    envReady,
    excluded: COST_EXCLUDE,
    apiCostUsd: 0.02, // what fetching this snapshot itself cost (2 CE calls)
  };
}

async function getCost() {
  const cached = await doc.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: "COST", SK: "LATEST" } }));
  const item = cached.Item;
  if (item?.payload && Date.now() - new Date(item.fetchedAt).getTime() < COST_MEMO_MS) {
    return json(200, JSON.parse(item.payload));
  }

  // One visitor pays the $0.02; concurrent ones get the previous snapshot.
  try {
    await doc.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: "COST", SK: "LATEST" },
      UpdateExpression: "SET refreshUntil = :until",
      ConditionExpression: "attribute_not_exists(refreshUntil) OR refreshUntil < :now",
      ExpressionAttributeValues: { ":until": nowS() + 120, ":now": nowS() },
    }));
  } catch (err) {
    if (err.name !== "ConditionalCheckFailedException") throw err;
    if (item?.payload) return json(200, JSON.parse(item.payload));
    return json(202, { message: "The ledger is being tallied; check back in a few seconds." });
  }

  const payload = await refreshCost();
  await doc.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: "COST", SK: "LATEST" },
    UpdateExpression: "SET payload = :p, fetchedAt = :at, refreshUntil = :zero",
    ExpressionAttributeValues: { ":p": JSON.stringify(payload), ":at": payload.asOf, ":zero": 0 },
  }));
  return json(200, payload);
}

// ---- router ------------------------------------------------------------------

const routes = {
  "GET /api/status": getStatus,
  "POST /api/drill": postDrill,
  "GET /api/drill/{id}": getDrill,
  "POST /api/sweep": postSweep,
  "GET /api/sweep/{id}": getSweep,
  "GET /api/ci": getCi,
  "GET /api/cost": getCost,
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
