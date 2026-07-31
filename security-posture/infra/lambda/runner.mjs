// The practice-smoke drill runner. A visitor lights a controlled, safe
// misconfiguration on a sandbox security group (attached to nothing, in an
// inert VPC), and this Lambda narrates the detect-and-respond loop live:
//
//   1  Stage the smoke   — open port 22 to 0.0.0.0/0 on the sandbox group.
//   2  The tripwire       — an EventBridge rule on the CloudTrail
//                           AuthorizeSecurityGroupIngress event fires the
//                           demo root's response Lambda, which revokes it.
//                           We watch the hole close and time it.
//   3  The inspector      — AWS Config's restricted-ssh rule rules on the
//                           same group independently, on its own cadence.
//
// The point of the exhibit is the honest contrast: an event-driven tripwire
// usually remediates before the periodic compliance inspector has even
// finished writing up its verdict. Every API call in this exchange — the
// visitor's authorize and the tripwire's revoke — lands in the KMS-encrypted
// CloudTrail the evidence report separately proves is logging.
//
// The runner keeps a failsafe revoke of its own: if the tripwire does not
// fire inside the watch window, the runner closes the hole itself and says so,
// so no drill can ever leave a smoke burning.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import {
  EC2Client, AuthorizeSecurityGroupIngressCommand,
  RevokeSecurityGroupIngressCommand, DescribeSecurityGroupsCommand,
} from "@aws-sdk/client-ec2";
import { ConfigServiceClient, GetComplianceDetailsByConfigRuleCommand } from "@aws-sdk/client-config-service";

const { TABLE_NAME, SSM_PREFIX } = process.env;

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const ssm = new SSMClient({});
const ec2 = new EC2Client({});
const config = new ConfigServiceClient({});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The one rule the drill ever opens: SSH from the whole internet.
const OPEN_RULE = {
  IpProtocol: "tcp",
  FromPort: 22,
  ToPort: 22,
  IpRanges: [{ CidrIp: "0.0.0.0/0", Description: "practice smoke: unrestricted SSH (staged, then remediated)" }],
};

// ---- DynamoDB progress streaming --------------------------------------------

async function setStage(runId, key, value) {
  await doc.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `RUN#${runId}`, SK: "META" },
    UpdateExpression: "SET #stages.#k = :v",
    ExpressionAttributeNames: { "#stages": "stages", "#k": key },
    ExpressionAttributeValues: { ":v": value },
  }));
}

async function log(runId, m) {
  await doc.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `RUN#${runId}`, SK: "META" },
    UpdateExpression: "SET #log = list_append(#log, :e)",
    ExpressionAttributeNames: { "#log": "log" },
    ExpressionAttributeValues: { ":e": [{ t: Date.now(), m }] },
  }));
}

async function finish(runId, createdAt, status, summary) {
  const updates = [
    doc.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `RUN#${runId}`, SK: "META" },
      UpdateExpression: "SET #s = :s, summary = :sum, finishedAt = :f",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": status, ":sum": summary, ":f": new Date().toISOString() },
    })),
    doc.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: "LOCK", SK: "GLOBAL" },
      UpdateExpression: "SET lockUntil = :zero",
      ConditionExpression: "runId = :id",
      ExpressionAttributeValues: { ":zero": 0, ":id": runId },
    })).catch(() => {}),
  ];
  // Keep the "recent drills" pointer item in step with the final status.
  if (createdAt) {
    updates.push(doc.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: "LIST", SK: `RUN#${createdAt}#${runId}` },
      UpdateExpression: "SET #s = :s",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": status },
    })).catch(() => {}));
  }
  await Promise.all(updates);
}

async function markRunning(runId) {
  await doc.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `RUN#${runId}`, SK: "META" },
    UpdateExpression: "SET #s = :s, startedAt = :a",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":s": "running", ":a": new Date().toISOString() },
  }));
}

// ---- helpers ----------------------------------------------------------------

async function ingressOpen(sgId) {
  const res = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [sgId] }));
  const perms = res.SecurityGroups?.[0]?.IpPermissions ?? [];
  return perms.some((p) =>
    p.FromPort === 22 && (p.IpRanges ?? []).some((r) => r.CidrIp === "0.0.0.0/0"));
}

async function failsafeRevoke(sgId) {
  try {
    await ec2.send(new RevokeSecurityGroupIngressCommand({ GroupId: sgId, IpPermissions: [OPEN_RULE] }));
    return true;
  } catch (err) {
    // InvalidPermission.NotFound == the tripwire beat us to it; that's fine.
    if (err.name === "InvalidPermission.NotFound") return false;
    throw err;
  }
}

// ---- the drill --------------------------------------------------------------

export const handler = async (event) => {
  const { runId, createdAt } = event;
  let stack;
  try {
    const names = ["sandbox-sg-id", "config-rule-name", "hold-seconds"].map((n) => `${SSM_PREFIX}/${n}`);
    const res = await ssm.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
    const get = (n) => res.Parameters?.find((p) => p.Name.endsWith(`/${n}`))?.Value;
    stack = { sgId: get("sandbox-sg-id"), ruleName: get("config-rule-name"), hold: Number(get("hold-seconds") || "300") };
    if (!stack.sgId) throw new Error("sandbox sg id missing");
  } catch (err) {
    console.error("discovery failed", err);
    await finish(runId, createdAt, "failed", { reason: "The demo stack was struck before the drill could start." });
    return;
  }

  await markRunning(runId);
  let closedByRunner = false;

  try {
    // ── Stage 1 · light the practice smoke ────────────────────────────────
    await setStage(runId, "stage", { state: "running", label: "Staging the smoke" });
    await ec2.send(new AuthorizeSecurityGroupIngressCommand({ GroupId: stack.sgId, IpPermissions: [OPEN_RULE] }));
    const t0 = Date.now();
    await setStage(runId, "stage", {
      state: "ok", label: "Staging the smoke",
      detail: "Port 22 opened to 0.0.0.0/0 on the sandbox group (attached to nothing, in an inert VPC).",
      at: new Date(t0).toISOString(),
    });
    await log(runId, `[stage] AuthorizeSecurityGroupIngress · tcp/22 · 0.0.0.0/0 on ${stack.sgId}`);
    await log(runId, "[stage] the call is now in CloudTrail; the tripwire watches that trail");

    // ── Stage 2 · watch the tripwire remediate ────────────────────────────
    await setStage(runId, "tripwire", { state: "running", label: "Watching for the tripwire" });
    await log(runId, "[tripwire] EventBridge rule armed on AuthorizeSecurityGroupIngress; the response Lambda will revoke it");

    const deadline = t0 + stack.hold * 1000;
    let closed = false;
    while (Date.now() < deadline) {
      await sleep(5000);
      if (!(await ingressOpen(stack.sgId))) { closed = true; break; }
      const elapsed = Math.round((Date.now() - t0) / 1000);
      await setStage(runId, "tripwire", { state: "running", label: "Watching for the tripwire", elapsedSec: elapsed });
    }

    const tripwireMs = Date.now() - t0;
    if (closed) {
      await setStage(runId, "tripwire", {
        state: "ok", label: "The tripwire fired",
        elapsedSec: Math.round(tripwireMs / 1000),
        closedBy: "tripwire",
        detail: "The response Lambda revoked the open rule automatically. No human touched it.",
      });
      await log(runId, `[tripwire] hole closed by the automated responder after ${Math.round(tripwireMs / 1000)}s`);
    } else {
      // Failsafe: the watch window lapsed with the hole still open.
      closedByRunner = await failsafeRevoke(stack.sgId);
      await setStage(runId, "tripwire", {
        state: closedByRunner ? "warn" : "ok",
        label: closedByRunner ? "The lookout closed it by hand" : "The tripwire fired late",
        elapsedSec: Math.round(tripwireMs / 1000),
        closedBy: closedByRunner ? "failsafe" : "tripwire",
        detail: closedByRunner
          ? `The tripwire did not fire inside the ${stack.hold}s watch window (CloudTrail-to-EventBridge delivery varies), so the runner's own failsafe revoke closed the hole. Nothing is left open.`
          : "The tripwire fired just as the watch window lapsed.",
      });
      await log(runId, closedByRunner
        ? "[tripwire] watch window lapsed; failsafe revoke closed the hole"
        : "[tripwire] closed at the edge of the watch window");
    }

    // ── Stage 3 · the periodic inspector's independent verdict ────────────
    await setStage(runId, "inspector", { state: "running", label: "Reading the inspector's verdict" });
    await log(runId, `[inspector] AWS Config rule ${stack.ruleName} evaluates the same group on its own cadence`);

    // Give Config a bounded chance to have recorded/evaluated the change.
    let evaluated = null;
    for (let i = 0; i < 8; i += 1) {
      try {
        const res = await config.send(new GetComplianceDetailsByConfigRuleCommand({
          ConfigRuleName: stack.ruleName,
          Limit: 25,
        }));
        const results = res.EvaluationResults ?? [];
        if (results.length) {
          const latest = results
            .slice()
            .sort((a, b) => (b.ResultRecordedTime?.getTime() ?? 0) - (a.ResultRecordedTime?.getTime() ?? 0))[0];
          evaluated = {
            compliance: latest.ComplianceType,
            recordedAt: latest.ResultRecordedTime?.toISOString() ?? null,
            observed: results.length,
          };
          if (results.some((r) => r.ComplianceType === "NON_COMPLIANT")) break;
        }
      } catch (err) {
        console.error("config read failed", err);
      }
      await sleep(8000);
    }

    if (evaluated) {
      const caughtOpen = evaluated.compliance === "NON_COMPLIANT";
      await setStage(runId, "inspector", {
        state: "ok", label: "The inspector ruled",
        compliance: evaluated.compliance,
        recordedAt: evaluated.recordedAt,
        detail: caughtOpen
          ? "Config still reads NON_COMPLIANT: the periodic inspector is one step behind the event tripwire, which had already closed the hole. That lag is the exhibit."
          : "Config reads COMPLIANT: by the time the inspector evaluated, the tripwire had already remediated the group.",
      });
      await log(runId, `[inspector] Config verdict: ${evaluated.compliance} (recorded ${evaluated.recordedAt})`);
    } else {
      await setStage(runId, "inspector", {
        state: "warn", label: "The inspector is still writing",
        detail: "Config had not finished evaluating the change when the drill ended. It records configuration items and evaluates on a periodic/change cadence that lags the event-driven tripwire by minutes; the make report cycle picks it up.",
      });
      await log(runId, "[inspector] Config had not posted a verdict before the drill closed");
    }

    await finish(runId, createdAt, "passed", {
      tripwireSec: Math.round(tripwireMs / 1000),
      closedBy: closed ? "tripwire" : (closedByRunner ? "failsafe" : "tripwire"),
      inspector: evaluated?.compliance ?? "pending",
      headline: closed
        ? `The automated tripwire closed a world-open SSH rule in ${Math.round(tripwireMs / 1000)}s, without a human.`
        : "The drill completed; the failsafe guaranteed nothing was left open.",
    });
    await log(runId, "[done] practice smoke cleared; the trail holds the whole exchange");
  } catch (err) {
    console.error("drill failed", err);
    // Best-effort: never leave the sandbox open on an error path.
    try { await failsafeRevoke(stack.sgId); } catch { /* already closed */ }
    await finish(runId, createdAt, "failed", { reason: "The drill hit an error and was closed out; the sandbox group was swept shut." });
  }
};
