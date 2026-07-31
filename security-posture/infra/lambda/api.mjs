// Exhibit API for the fire-lookout plank. Three always-on exhibits (policy
// desk simulate/validate, perimeter fence log) plus the gate for the
// practice-smoke drill, whose heavy work happens in sec-drill-runner
// (invoked async); this function only gates and reads.
//
// The demo stack is discovered through SSM parameters the demo root writes.
// Between demo windows the parameters are gone and POST /api/drills answers
// honestly with 503 — the policy desk and fence log keep working, because
// IAM and the shared WAF exist year-round. Guardrails: a one-drill-at-a-time
// lock (extra POSTs get a 409 pointing at the drill already under way, so
// visitors share the live view) and atomic global daily counters.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { IAMClient, SimulatePrincipalPolicyCommand } from "@aws-sdk/client-iam";
import { AccessAnalyzerClient, ValidatePolicyCommand } from "@aws-sdk/client-accessanalyzer";
import { WAFV2Client, GetSampledRequestsCommand } from "@aws-sdk/client-wafv2";
import { CloudWatchClient, ListMetricsCommand, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { randomUUID } from "node:crypto";

const {
  TABLE_NAME, SSM_PREFIX, RUNNER_FUNCTION,
  BOUNDARY_ROLE_ARN, SITE_BUCKET_ARN, WAF_ACL_ARN,
} = process.env;
const DRILL_LIMIT = Number(process.env.DRILL_DAILY_LIMIT ?? "10");
const POLICY_LIMIT = Number(process.env.POLICY_DAILY_LIMIT ?? "500");
const WAF_RULES = JSON.parse(process.env.WAF_RULES ?? "[]");
const LOCK_SECONDS = 600; // a wedged runner can hold the tower this long at most

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const ssm = new SSMClient({});
const lambda = new LambdaClient({});
const iam = new IAMClient({});
const analyzer = new AccessAnalyzerClient({});
const waf = new WAFV2Client({});
const cw = new CloudWatchClient({});

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
  const names = ["sandbox-sg-id", "config-rule-name", "hold-seconds"]
    .map((n) => `${SSM_PREFIX}/${n}`);
  const res = await ssm.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
  const get = (n) => res.Parameters?.find((p) => p.Name.endsWith(`/${n}`))?.Value;
  const value = res.Parameters?.length === names.length
    ? {
        sandboxSgId: get("sandbox-sg-id"),
        configRuleName: get("config-rule-name"),
        holdSeconds: Number(get("hold-seconds")),
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

// One drill on the board at a time. The claim is conditional so racing
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
  try {
    await doc.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: "LOCK", SK: "GLOBAL" },
      UpdateExpression: "SET lockUntil = :zero",
      ConditionExpression: "runId = :id",
      ExpressionAttributeValues: { ":zero": 0, ":id": runId },
    }));
  } catch (err) {
    if (err.name !== "ConditionalCheckFailedException") console.error("lock release failed", err);
  }
}

// Atomic global daily caps: the slot is claimed BEFORE any work happens, and
// the condition makes over-claiming impossible no matter how many Lambdas
// race. Drills and policy-desk calls share the day item as separate attrs.
async function claimDailySlot(attr, limit) {
  try {
    const res = await doc.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `USAGE#${today()}`, SK: "GLOBAL" },
      UpdateExpression: "ADD #n :one SET #ttl = if_not_exists(#ttl, :ttl)",
      ConditionExpression: "attribute_not_exists(#n) OR #n < :limit",
      ExpressionAttributeNames: { "#n": attr, "#ttl": "ttl" },
      ExpressionAttributeValues: { ":one": 1, ":limit": limit, ":ttl": nowS() + 72 * 3600 },
      ReturnValues: "UPDATED_NEW",
    }));
    return res.Attributes?.[attr] ?? 1;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return null;
    throw err;
  }
}

// ---- status ------------------------------------------------------------------

async function getStatus() {
  const [stack, usageRes, lock] = await Promise.all([
    demoStack(),
    doc.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `USAGE#${today()}`, SK: "GLOBAL" } })),
    currentLock(),
  ]);
  return json(200, {
    deployed: Boolean(stack),
    holdSeconds: stack?.holdSeconds ?? null,
    drill: {
      used: usageRes.Item?.drills ?? 0,
      limit: DRILL_LIMIT,
      running: lock ? { runId: lock.runId, startedAt: lock.startedAt } : null,
    },
    policy: { used: usageRes.Item?.policy ?? 0, limit: POLICY_LIMIT },
  });
}

// ---- the practice-smoke drill ------------------------------------------------

async function postDrill() {
  const stack = await demoStack();
  if (!stack) {
    return json(503, {
      message:
        "The tower is dark: the demo stack is struck between windows, so there is no tripwire, " +
        "no inspector, and no sandbox to stage a smoke on. The season report below is the latest evidence.",
    });
  }

  const runId = `smk-${randomUUID().replaceAll("-", "").slice(0, 8)}`;

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
        "A practice smoke is already on the board. One drill at a time; " +
        "you are watching the drill that is under way.",
      ...(inflightId ? { runId: inflightId } : {}),
    });
  }

  try {
    const round = await claimDailySlot("drills", DRILL_LIMIT);
    if (round === null) {
      await releaseLock(runId);
      return json(429, {
        message: `The drill book is full: ${DRILL_LIMIT} practice smokes per UTC day across all visitors. It resets at 00:00 UTC.`,
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
      roundLimit: DRILL_LIMIT,
      holdSeconds: stack.holdSeconds,
      sandboxSgId: stack.sandboxSgId,
      stages: {},
      summary: null,
      log: [{ t: Date.now(), m: `[dispatch] practice smoke ${runId} accepted · drill ${round} of ${DRILL_LIMIT} today` }],
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
      return json(502, { message: "The drill runner could not be dispatched; try again in a minute." });
    }

    return json(202, { runId, round, limit: DRILL_LIMIT });
  } catch (err) {
    await releaseLock(runId);
    throw err;
  }
}

async function getDrill(event) {
  const id = event.pathParameters?.id ?? "";
  if (!/^smk-[a-f0-9]{8}$/.test(id)) {
    return json(400, { message: "Drill ids look like smk-1a2b3c4d" });
  }
  const res = await doc.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `RUN#${id}`, SK: "META" } }));
  if (!res.Item) return json(404, { message: "No such drill (records expire after 48h)" });
  const { PK, SK, ttl, ...run } = res.Item;
  return json(200, { run });
}

async function listDrills() {
  const res = await doc.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "PK = :list",
    ExpressionAttributeValues: { ":list": "LIST" },
    ScanIndexForward: false,
    Limit: 10,
  }));
  const runs = (res.Items ?? []).map(({ PK, SK, ttl, ...r }) => r);
  return json(200, { runs });
}

// ---- the policy desk ---------------------------------------------------------
// Everything here is a free, read-only IAM evaluation: SimulatePrincipalPolicy
// answers from the boundary role's real policy + boundary intersection, and
// ValidatePolicy is Access Analyzer's own linter. Visitor-typed text goes ONLY
// to ValidatePolicy, which evaluates a document and touches nothing.

const SIM_CASES = [
  {
    action: "s3:GetObject",
    resource: `${SITE_BUCKET_ARN}/evidence/status.json`,
    inPolicy: true, inBoundary: true,
    note: "granted by the policy AND inside the ceiling",
  },
  {
    action: "s3:PutObject",
    resource: `${SITE_BUCKET_ARN}/evidence/status.json`,
    inPolicy: true, inBoundary: false,
    note: "granted by the role's policy, blocked by the boundary",
  },
  {
    action: "s3:ListBucket",
    resource: SITE_BUCKET_ARN,
    inPolicy: false, inBoundary: true,
    note: "inside the ceiling, but no policy grants it",
  },
  {
    action: "iam:CreateUser",
    resource: "*",
    inPolicy: false, inBoundary: false,
    note: "granted by nothing",
  },
];

async function policySimulate() {
  const slot = await claimDailySlot("policy", POLICY_LIMIT);
  if (slot === null) {
    return json(429, { message: "The policy desk is closed for the day (global daily cap). It reopens at 00:00 UTC." });
  }

  const rows = await Promise.all(SIM_CASES.map(async (c) => {
    const { EvaluationResults } = await iam.send(new SimulatePrincipalPolicyCommand({
      PolicySourceArn: BOUNDARY_ROLE_ARN,
      ActionNames: [c.action],
      ResourceArns: [c.resource],
    }));
    const r = EvaluationResults?.[0] ?? {};
    return {
      action: c.action,
      resource: c.resource.replace(/^arn:aws:s3:::/, ""),
      inPolicy: c.inPolicy,
      inBoundary: c.inBoundary,
      note: c.note,
      decision: r.EvalDecision ?? "unknown",
      allowedByBoundary: r.PermissionsBoundaryDecisionDetail?.AllowedByPermissionsBoundary ?? null,
    };
  }));

  return json(200, { roleArn: BOUNDARY_ROLE_ARN, rows });
}

// Curated exhibits chosen so each finding type has a specimen. The "clean"
// one matters too: the linter passing is also evidence.
const VALIDATE_EXHIBITS = {
  "typo-action": {
    label: "A typo in an action name",
    policy: {
      Version: "2012-10-17",
      Statement: [{ Sid: "ReadReports", Effect: "Allow", Action: "s3:GetObjekt", Resource: "arn:aws:s3:::example-bucket/*" }],
    },
  },
  "star-passrole": {
    label: "iam:PassRole with Resource *",
    policy: {
      Version: "2012-10-17",
      Statement: [{ Sid: "LetAnythingBeAnything", Effect: "Allow", Action: ["iam:PassRole", "ec2:RunInstances"], Resource: "*" }],
    },
  },
  "missing-version": {
    label: "Statement without a Version element",
    policy: {
      Statement: [{ Sid: "OldTimer", Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::example-bucket/*" }],
    },
  },
  "clean": {
    label: "A tight, single-purpose grant",
    policy: {
      Version: "2012-10-17",
      Statement: [{ Sid: "ReadOneReport", Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::example-bucket/reports/season.json" }],
    },
  },
};

async function policyValidate(event) {
  let body;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return json(400, { message: "Request body must be JSON" });
  }

  let policyDocument;
  let exhibit = null;
  if (typeof body.exhibitId === "string") {
    exhibit = VALIDATE_EXHIBITS[body.exhibitId];
    if (!exhibit) return json(400, { message: "Unknown exhibit id" });
    policyDocument = JSON.stringify(exhibit.policy);
  } else if (typeof body.policy === "string") {
    if (body.policy.length > 8192) {
      return json(400, { message: "Policies over 8 KB are beyond the desk; trim it down" });
    }
    try {
      JSON.parse(body.policy);
    } catch {
      return json(400, { message: "That is not valid JSON yet; the linter reads policy documents, not fragments" });
    }
    policyDocument = body.policy;
  } else {
    return json(400, { message: "Send an exhibitId or a policy (JSON string)" });
  }

  const policyType = body.policyType === "RESOURCE_POLICY" ? "RESOURCE_POLICY" : "IDENTITY_POLICY";

  const slot = await claimDailySlot("policy", POLICY_LIMIT);
  if (slot === null) {
    return json(429, { message: "The policy desk is closed for the day (global daily cap). It reopens at 00:00 UTC." });
  }

  try {
    const res = await analyzer.send(new ValidatePolicyCommand({
      policyDocument,
      policyType,
      maxResults: 20,
    }));
    return json(200, {
      exhibitId: body.exhibitId ?? null,
      label: exhibit?.label ?? "your policy",
      policy: JSON.parse(policyDocument),
      findings: (res.findings ?? []).map((f) => ({
        findingType: f.findingType,
        issueCode: f.issueCode,
        findingDetails: f.findingDetails,
        learnMoreLink: f.learnMoreLink,
      })),
    });
  } catch (err) {
    // Access Analyzer's own rejection text is the teaching copy, verbatim —
    // the same move as plank 3's event-pattern tester.
    if (err.name === "ValidationException" || err.$metadata?.httpStatusCode === 400) {
      return json(200, {
        exhibitId: body.exhibitId ?? null,
        label: exhibit?.label ?? "your policy",
        findings: [],
        serviceError: { name: err.name, message: err.message },
      });
    }
    throw err;
  }
}

// ---- the perimeter fence log -------------------------------------------------
// GetSampledRequests returns the shared edge ACL's last ~3 hours of real
// sampled hits per rule; CloudWatch adds 24h totals. Both are free. Client
// IPs are masked before they leave: the exhibit is the traffic, not the
// senders. Memoized per container: the fence does not need hammering.

const ACL_NAME = (WAF_ACL_ARN ?? "").split("/")[2] ?? "";
let fenceCache = { at: 0, value: null };
let metricDimsCache = null;

const maskIp = (ip) => {
  if (!ip) return "unknown";
  if (ip.includes(":")) {
    const parts = ip.split(":");
    return `${parts[0]}:${parts[1]}:…`;
  }
  return ip.replace(/\.\d+$/, ".x");
};

async function discoverMetrics() {
  if (metricDimsCache) return metricDimsCache;
  const found = [];
  for (const metricName of ["BlockedRequests", "AllowedRequests"]) {
    let nextToken;
    do {
      const res = await cw.send(new ListMetricsCommand({
        Namespace: "AWS/WAFV2", MetricName: metricName, NextToken: nextToken,
      }));
      for (const m of res.Metrics ?? []) {
        const dims = Object.fromEntries((m.Dimensions ?? []).map((d) => [d.Name, d.Value]));
        if (dims.WebACL === ACL_NAME) found.push({ metricName, metric: m, rule: dims.Rule ?? "ALL" });
      }
      nextToken = res.NextToken;
    } while (nextToken);
  }
  metricDimsCache = found;
  return found;
}

async function getFence() {
  if (fenceCache.value && Date.now() - fenceCache.at < 5 * 60_000) {
    return json(200, { ...fenceCache.value, cached: true });
  }

  const end = new Date();
  const start = new Date(end.getTime() - 3 * 3600_000);

  const rules = await Promise.all(WAF_RULES.map(async (r) => {
    const res = await waf.send(new GetSampledRequestsCommand({
      WebAclArn: WAF_ACL_ARN,
      RuleMetricName: r.metric,
      Scope: "CLOUDFRONT",
      TimeWindow: { StartTime: start, EndTime: end },
      MaxItems: 100,
    }));
    const samples = res.SampledRequests ?? [];
    const actions = {};
    for (const s of samples) actions[s.Action] = (actions[s.Action] ?? 0) + 1;
    const recent = samples
      .sort((a, b) => (b.Timestamp?.getTime() ?? 0) - (a.Timestamp?.getTime() ?? 0))
      .slice(0, 10)
      .map((s) => ({
        at: s.Timestamp?.toISOString() ?? null,
        country: s.Request?.Country ?? "??",
        method: s.Request?.Method ?? "?",
        uri: (s.Request?.URI ?? "").slice(0, 80),
        action: s.Action,
        ip: maskIp(s.Request?.ClientIP),
        ruleWithin: s.RuleNameWithinRuleGroup && s.RuleNameWithinRuleGroup !== "" ? s.RuleNameWithinRuleGroup : null,
      }));
    return { metric: r.metric, label: r.label, sampleCount: samples.length, actions, recent };
  }));

  // 24h totals from CloudWatch: per-rule blocks + the ACL-wide pass count.
  let totals = { blocked24h: null, allowed24h: null, perRule: {} };
  try {
    const wanted = await discoverMetrics();
    if (wanted.length) {
      const res = await cw.send(new GetMetricDataCommand({
        StartTime: new Date(end.getTime() - 24 * 3600_000),
        EndTime: end,
        MetricDataQueries: wanted.map((w, i) => ({
          Id: `m${i}`,
          MetricStat: { Metric: w.metric, Period: 86400, Stat: "Sum" },
        })),
      }));
      wanted.forEach((w, i) => {
        const sum = (res.MetricDataResults?.find((d) => d.Id === `m${i}`)?.Values ?? []).reduce((a, b) => a + b, 0);
        if (w.metricName === "BlockedRequests") {
          totals.blocked24h = (totals.blocked24h ?? 0) + sum;
          if (w.rule !== "ALL") totals.perRule[w.rule] = sum;
        } else if (w.rule === "ALL") {
          totals.allowed24h = (totals.allowed24h ?? 0) + sum;
        }
      });
    }
  } catch (err) {
    console.error("fence totals unavailable", err);
  }

  const value = {
    aclName: ACL_NAME,
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    rules,
    totals,
    note: "Sampled requests cover roughly the last three hours. Client IPs are masked deliberately.",
  };
  fenceCache = { at: Date.now(), value };
  return json(200, value);
}

// ---- router ------------------------------------------------------------------

const routes = {
  "GET /api/status": getStatus,
  "GET /api/drills": listDrills,
  "GET /api/drills/{id}": getDrill,
  "POST /api/drills": postDrill,
  "POST /api/policy/simulate": policySimulate,
  "POST /api/policy/validate": policyValidate,
  "GET /api/fence": getFence,
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
