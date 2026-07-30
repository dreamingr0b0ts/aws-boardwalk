// Closing-sweep runner: patrol skis every live boardwalk site, one run at a
// time, writing each check into the run record so the page fills in as the
// sweep moves down the mountain. Checks are plain HTTPS GETs from Lambda:
// status, full-body latency, size, and the security headers every plank is
// supposed to wear (HSTS + CSP). Free to run; paced so the board reads as a
// patrol run, not a burst.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const { TABLE_NAME } = process.env;
const PACE_MS = 900;
const TIMEOUT_MS = 6000;

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function checkSite(site) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(`https://${site.host}/`, {
      signal: ctl.signal,
      redirect: "follow",
      headers: { "user-agent": "boardwalk-ops-closing-sweep" },
    });
    const body = await res.arrayBuffer();
    const ms = Date.now() - t0;
    return {
      ...site,
      status: res.ok ? "ok" : "fail",
      httpStatus: res.status,
      ms,
      bytes: body.byteLength,
      hsts: res.headers.has("strict-transport-security"),
      csp: res.headers.has("content-security-policy"),
      xcache: (res.headers.get("x-cache") ?? "").split(" ")[0] || null,
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      ...site,
      status: "fail",
      httpStatus: null,
      ms: Date.now() - t0,
      error: err.name === "AbortError" ? `no answer in ${TIMEOUT_MS / 1000}s` : "unreachable",
      checkedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(t);
  }
}

async function writeCheck(runId, index, check) {
  await doc.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `RUN#${runId}`, SK: "META" },
    UpdateExpression: `SET checks[${index}] = :c`,
    ExpressionAttributeValues: { ":c": check },
  }));
}

export const handler = async (event) => {
  const { runId, sites } = event;
  const startedAt = Date.now();
  let okCount = 0;

  try {
    for (let i = 0; i < sites.length; i += 1) {
      // Mark the run under way so the page shows patrol arriving at the site.
      await writeCheck(runId, i, { ...sites[i], status: "checking" });
      const check = await checkSite(sites[i]);
      if (check.status === "ok") okCount += 1;
      await writeCheck(runId, i, check);
      if (i < sites.length - 1) await sleep(PACE_MS);
    }

    await doc.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `RUN#${runId}`, SK: "META" },
      UpdateExpression: "SET #s = :s, summary = :sum",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":s": "done",
        ":sum": {
          ok: okCount,
          total: sites.length,
          sweptInS: Math.round((Date.now() - startedAt) / 1000),
        },
      },
    }));
  } catch (err) {
    console.error("sweep failed", err);
    await doc.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `RUN#${runId}`, SK: "META" },
      UpdateExpression: "SET #s = :s",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": "failed" },
    })).catch(() => {});
    throw err;
  } finally {
    // Hand the mountain back whatever happened above.
    await doc.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: "LOCK", SK: "SWEEP" },
      UpdateExpression: "SET lockUntil = :zero",
      ConditionExpression: "runId = :id",
      ExpressionAttributeValues: { ":zero": 0, ":id": runId },
    })).catch((err) => {
      if (err.name !== "ConditionalCheckFailedException") console.error("sweep lock release", err);
    });
  }
};
