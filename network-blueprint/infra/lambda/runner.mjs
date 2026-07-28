// The inspection runner: walks the site one probe at a time so the page can
// watch the round move. Each probe is its own SSM Run Command invocation
// (they are free, and per-probe commands are what make the field book stream
// instead of dumping); every completion is flushed to the run record in
// DynamoDB, which the page polls. The final stage re-reads the four
// Reachability Analyzer verdicts from this window's deploy and checks the
// field results agree with the plan.
//
// Probe names, expectations, and judges mirror the evidence report Lambda
// (demo/lambda/report.mjs) — the on-demand round and the filed evidence must
// speak the same language.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  SSMClient, GetParametersCommand, SendCommandCommand, GetCommandInvocationCommand,
  DescribeInstanceInformationCommand,
} from "@aws-sdk/client-ssm";
import { EC2Client, DescribeNetworkInsightsAnalysesCommand } from "@aws-sdk/client-ec2";

const { TABLE_NAME, SSM_PREFIX } = process.env;
const REGION = process.env.AWS_REGION ?? "us-east-1";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const ssm = new SSMClient({});
const ec2 = new EC2Client({});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowS = () => Math.floor(Date.now() / 1000);

async function demoStack() {
  const names = ["public-instance-id", "private-instance-id", "private-app-ip", "analyses"]
    .map((n) => `${SSM_PREFIX}/${n}`);
  const res = await ssm.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
  const get = (n) => res.Parameters?.find((p) => p.Name.endsWith(`/${n}`))?.Value;
  return res.Parameters?.length === names.length
    ? {
        publicInstanceId: get("public-instance-id"),
        privateInstanceId: get("private-instance-id"),
        privateAppIp: get("private-app-ip"),
        analyses: JSON.parse(get("analyses")),
      }
    : null;
}

// ---- probe suites (web first: the inspector walks in from the street) --------

const probeSuites = (stack) => [
  {
    from: "public-web",
    tag: "web",
    instanceId: stack.publicInstanceId,
    enter: "entering the public tier, in from the street through the IGW",
    probes: [
      {
        name: "public-internet-egress",
        label: "public web tier to the internet",
        expect: "reachable via the IGW",
        show: "curl https://example.com",
        cmd: `curl -s -m 10 -o /dev/null -w "%{http_code}" https://example.com`,
        judge: (rc, out) => rc === 0 && out.startsWith("2"),
      },
      {
        name: "web-to-app-8080",
        label: "web tier to app tier :8080",
        expect: "reachable: app SG admits the web SG",
        show: `curl http://${stack.privateAppIp}:8080/`,
        cmd: `curl -s -m 6 -o /dev/null -w "%{http_code}" http://${stack.privateAppIp}:8080/`,
        judge: (rc, out) => rc === 0 && out.startsWith("2"),
      },
      {
        name: "web-to-data-5432",
        label: "web tier to app tier :5432",
        expect: "blocked by the app tier's security group",
        show: `tcp connect ${stack.privateAppIp}:5432`,
        cmd: `timeout 5 bash -c "</dev/tcp/${stack.privateAppIp}/5432"`,
        judge: (rc) => rc !== 0,
      },
    ],
  },
  {
    from: "private-app",
    tag: "app",
    instanceId: stack.privateInstanceId,
    enter: "entering the private tier, in over the PrivateLink endpoints (no internet path exists)",
    probes: [
      {
        name: "private-internet-egress",
        label: "private app tier to the internet",
        expect: "blocked: no NAT, no route",
        show: "curl https://example.com",
        cmd: `curl -s -m 6 -o /dev/null -w "%{http_code}" https://example.com`,
        judge: (rc) => rc !== 0,
      },
      {
        name: "private-s3-gateway",
        label: "private app tier to S3 (gateway endpoint)",
        expect: "reachable: prefix-list route, $0",
        show: `curl https://s3.${REGION}.amazonaws.com`,
        cmd: `curl -s -m 10 -o /dev/null -w "%{http_code}" https://s3.${REGION}.amazonaws.com`,
        judge: (rc, out) => rc === 0 && out !== "000",
      },
      {
        name: "private-ddb-gateway",
        label: "private app tier to DynamoDB (gateway endpoint)",
        expect: "reachable: prefix-list route, $0",
        show: `curl https://dynamodb.${REGION}.amazonaws.com`,
        cmd: `curl -s -m 10 -o /dev/null -w "%{http_code}" https://dynamodb.${REGION}.amazonaws.com`,
        judge: (rc, out) => rc === 0 && out.startsWith("2"),
      },
      {
        name: "imdsv1-blocked",
        label: "IMDSv1 request (no session token)",
        expect: "rejected with 401",
        show: "curl http://169.254.169.254/latest/meta-data/",
        cmd: `curl -s -m 4 -o /dev/null -w "%{http_code}" http://169.254.169.254/latest/meta-data/`,
        judge: (rc, out) => rc === 0 && out === "401",
      },
      {
        name: "imdsv2-works",
        label: "IMDSv2 request (session token)",
        expect: "answers with the instance id",
        show: "curl -H \"X-aws-ec2-metadata-token: ...\" .../instance-id",
        cmd: `T=$(curl -sX PUT -m 4 "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60") && curl -s -m 4 -H "X-aws-ec2-metadata-token: $T" http://169.254.169.254/latest/meta-data/instance-id`,
        judge: (rc, out) => rc === 0 && out.startsWith("i-"),
      },
    ],
  },
];

// One probe = one command. The script always exits 0 so the invocation stays
// Success; judgement happens here from the RESULT line.
async function runProbe(instanceId, probe) {
  const script = [
    `out=$(eval '${probe.cmd}' 2>&1); rc=$?; echo "RESULT|${probe.name}|$rc|$out"`,
    "exit 0",
  ];
  const { Command } = await ssm.send(new SendCommandCommand({
    InstanceIds: [instanceId],
    DocumentName: "AWS-RunShellScript",
    Parameters: { commands: script, executionTimeout: ["60"] },
  }));

  let inv;
  for (let i = 0; i < 20; i += 1) {
    await sleep(1500);
    try {
      inv = await ssm.send(new GetCommandInvocationCommand({ CommandId: Command.CommandId, InstanceId: instanceId }));
    } catch { continue; } // InvocationDoesNotExist until the agent picks it up
    if (["Success", "Failed", "TimedOut", "Cancelled"].includes(inv.Status)) break;
  }

  const line = (inv?.StandardOutputContent ?? "").split("\n").find((l) => l.startsWith(`RESULT|${probe.name}|`));
  if (!line) return { pass: false, detail: `no result (invocation ${inv?.Status ?? "never ran"})` };
  const [, , rc, ...rest] = line.split("|");
  const out = rest.join("|").trim();
  return {
    pass: probe.judge(Number(rc), out),
    detail: `exit ${rc}${out ? `, ${out.slice(0, 60)}` : ""}`,
  };
}

// ---- run-record persistence --------------------------------------------------

function makeRecorder(runId) {
  const state = { status: "queued", probes: [], plan: null, log: [] };
  return {
    state,
    log(m) { state.log.push({ t: Date.now(), m }); },
    async flush(extra = {}) {
      Object.assign(state, extra);
      await doc.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `RUN#${runId}`, SK: "META" },
        UpdateExpression: "SET #st = :st, probes = :probes, #plan = :plan, #log = list_append(if_not_exists(#log, :empty), :log)",
        ExpressionAttributeNames: { "#st": "status", "#log": "log", "#plan": "plan" },
        ExpressionAttributeValues: {
          ":st": state.status,
          ":probes": state.probes,
          ":plan": state.plan,
          ":log": state.log.splice(0), // append-only: hand over pending lines
          ":empty": [],
        },
      }));
    },
  };
}

async function finishListItem(runId, createdAt, status, summary) {
  await doc.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: "LIST", SK: `RUN#${createdAt}#${runId}` },
    UpdateExpression: "SET #st = :st, #sum = :sum",
    ExpressionAttributeNames: { "#st": "status", "#sum": "summary" },
    ExpressionAttributeValues: { ":st": status, ":sum": summary },
  })).catch(() => {});
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

async function setFinished(runId) {
  await doc.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `RUN#${runId}`, SK: "META" },
    UpdateExpression: "SET finishedAt = :at",
    ExpressionAttributeValues: { ":at": new Date().toISOString() },
  })).catch(() => {});
}

// ---- the round ---------------------------------------------------------------

export const handler = async (event) => {
  const runId = event?.runId;
  if (!/^insp-[a-f0-9]{8}$/.test(runId ?? "")) return;
  const rec = makeRecorder(runId);
  const startedMs = Date.now();
  const createdAt = event?.createdAt ?? ""; // the API passes it so the LIST pointer can be finalized

  try {
    const stack = await demoStack();
    if (!stack) throw new Error("demo stack parameters are gone; the site was struck mid-round");

    const info = await ssm.send(new DescribeInstanceInformationCommand({
      Filters: [{ Key: "InstanceIds", Values: [stack.publicInstanceId, stack.privateInstanceId] }],
    }));
    const online = new Set((info.InstanceInformationList ?? [])
      .filter((i) => i.PingStatus === "Online").map((i) => i.InstanceId));
    if (online.size < 2) {
      throw new Error("the site is still being staked out (SSM registration incomplete); try again in a few minutes");
    }

    rec.log(`[dispatch] site check: stack LIVE · web ${stack.publicInstanceId} · app ${stack.privateInstanceId} · both Online in SSM`);
    rec.log("[dispatch] the inspector goes in over SSM Run Command: no SSH, no bastion, no key pairs");
    await rec.flush({ status: "dispatching" });

    // seed the probe list so the page can draw every row up front
    for (const suite of probeSuites(stack)) {
      for (const p of suite.probes) {
        rec.state.probes.push({ name: p.name, from: suite.from, label: p.label, expect: p.expect, status: "pending" });
      }
    }

    let allPass = true;
    for (const suite of probeSuites(stack)) {
      rec.log(`[${suite.tag}] ${suite.enter}`);
      await rec.flush({ status: suite.tag === "web" ? "probing-web" : "probing-app" });

      for (const probe of suite.probes) {
        // Stay well inside the Lambda timeout so a slow SSM agent ends the
        // round as an honest error (lock released) instead of a silent kill.
        if (Date.now() - startedMs > 190_000) {
          throw new Error("the round ran out of time; SSM was slow to answer");
        }
        const row = rec.state.probes.find((p) => p.name === probe.name);
        row.status = "running";
        rec.log(`[${suite.tag}] probe ${probe.name}`);
        rec.log(`[${suite.tag}]   $ ${probe.show}`);
        await rec.flush();

        const res = await runProbe(suite.instanceId, probe);
        row.status = res.pass ? "pass" : "fail";
        row.detail = res.detail;
        if (!res.pass) allPass = false;
        rec.log(`[${suite.tag}]   ${res.pass ? "OK" : "XX"} ${probe.expect} (${res.detail}) · ${res.pass ? "as designed" : "UNEXPECTED"}`);
        await rec.flush();
      }
    }

    // plan check: the analyzer verdicts from this window's deploy
    rec.log("[plan] pulling the four Reachability Analyzer verdicts from the plan check");
    await rec.flush({ status: "comparing" });

    const { NetworkInsightsAnalyses } = await ec2.send(new DescribeNetworkInsightsAnalysesCommand({
      NetworkInsightsAnalysisIds: stack.analyses.map((a) => a.id),
    }));
    const byId = new Map((NetworkInsightsAnalyses ?? []).map((a) => [a.NetworkInsightsAnalysisId, a]));
    const plan = stack.analyses.map((def) => {
      const a = byId.get(def.id) ?? {};
      const found = a.NetworkPathFound === true;
      const pass = a.Status === "succeeded" && found === def.expect;
      rec.log(`[plan]   ${pass ? "OK" : "XX"} ${def.label}: ${found ? "reachable" : "not reachable"} · ${pass ? "matches the design" : "DISAGREES"}`);
      return { key: def.key, label: def.label, expect: def.expect, reachable: found, pass };
    });
    const agree = plan.filter((p) => p.pass).length;
    rec.state.plan = { agree, total: plan.length, verdicts: plan };
    rec.log(`[plan] field inspection against the plan check: ${agree}/${plan.length} in agreement`);
    await rec.flush();

    const passCount = rec.state.probes.filter((p) => p.status === "pass").length;
    const verdictPass = allPass && agree === plan.length;
    const secs = ((Date.now() - startedMs) / 1000).toFixed(0);
    rec.log(`[filed] ${passCount}/${rec.state.probes.length} probes as designed · plan agreement ${agree}/${plan.length}`);
    rec.log(`[filed] round ${runId} complete in ${secs}s · recorded in the day book`);
    await rec.flush({ status: verdictPass ? "passed" : "failed" });
    await finishListItem(runId, createdAt, rec.state.status,
      `${passCount}/${rec.state.probes.length} probes · plan ${agree}/${plan.length}`);
  } catch (err) {
    console.error("round failed", err);
    rec.log(`[filed] round abandoned: ${String(err.message ?? err).slice(0, 140)}`);
    await rec.flush({ status: "error" }).catch(() => {});
    await finishListItem(runId, createdAt, "error", "round abandoned");
  } finally {
    await setFinished(runId);
    await releaseLock(runId);
  }
};
