// Anonymous landing data and the public bench records. Two routes:
//   GET /api/public/info     — model roster, scenario catalog, limits, counters
//   GET /api/public/records  — 30-day per-model aggregates from the audit
//                              ledger (runs, p50 latency, cost); reads only
//                              numbers, never prompt previews or identities.
// This function's role has NO bedrock permissions — nothing here can spend a
// token, which is why the records page is free to serve to anyone.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { catalog } from "./scenarios.mjs";

const TABLE = process.env.TABLE_NAME;
const MODELS = JSON.parse(process.env.MODELS);
const USER_DAILY_LIMIT = Number(process.env.USER_DAILY_LIMIT ?? 30);
const GLOBAL_DAILY_LIMIT = Number(process.env.GLOBAL_DAILY_LIMIT ?? 120);
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS ?? 500);
const ANON_DAILY_LIMIT = Number(process.env.ANON_DAILY_LIMIT ?? 5);
const ANON_MAX_OUTPUT_TOKENS = Number(process.env.ANON_MAX_OUTPUT_TOKENS ?? 300);
const RECORDS_WINDOW_DAYS = 30; // matches the ledger's TTL

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

async function info() {
  let globalUsed = 0;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `USAGE#${today}`, SK: "GLOBAL" } }));
    globalUsed = Number(res.Item?.count ?? 0);
  } catch {
    /* landing stats are cosmetic */
  }

  return json(200, {
    models: MODELS,
    scenarios: catalog(),
    limits: {
      userDailyRuns: USER_DAILY_LIMIT,
      globalDailyRuns: GLOBAL_DAILY_LIMIT,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      anonDailyRuns: ANON_DAILY_LIMIT,
      anonMaxOutputTokens: ANON_MAX_OUTPUT_TOKENS,
    },
    stats: { globalUsed },
  });
}

// ---- bench records ---------------------------------------------------------

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

async function queryDay(date) {
  const items = [];
  let cursor;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": `RUN#${date}` },
        ProjectionExpression: "#r",
        ExpressionAttributeNames: { "#r": "results" },
        ExclusiveStartKey: cursor,
      })
    );
    items.push(...(res.Items ?? []));
    cursor = res.LastEvaluatedKey;
  } while (cursor);
  return items;
}

// The ledger is small (a few thousand slim rows at most), so aggregating on
// read is fine; a 5-minute in-container memo keeps repeat visits free.
let memo = { at: 0, body: null };

async function records() {
  if (memo.body && Date.now() - memo.at < 5 * 60 * 1000) return json(200, memo.body);

  const days = [];
  for (let i = RECORDS_WINDOW_DAYS - 1; i >= 0; i--) {
    days.push(new Date(Date.now() - i * 86400 * 1000).toISOString().slice(0, 10));
  }
  const perDay = await Promise.all(days.map(queryDay));

  const agg = new Map(MODELS.map((m) => [m.key, { latencies: [], costUsd: 0, runs: 0, ok: 0, byDay: days.map(() => []) }]));
  let totalRuns = 0;
  let totalCostUsd = 0;
  perDay.forEach((items, di) => {
    for (const it of items) {
      totalRuns += 1;
      for (const r of it.results ?? []) {
        const a = agg.get(r.key);
        if (!a) continue;
        a.runs += 1;
        a.costUsd += Number(r.costUsd ?? 0);
        totalCostUsd += Number(r.costUsd ?? 0);
        if (r.ok && r.latencyMs > 0) {
          a.ok += 1;
          a.latencies.push(r.latencyMs);
          a.byDay[di].push(r.latencyMs);
        }
      }
    }
  });

  const round6 = (n) => Math.round(n * 1e6) / 1e6;
  const body = {
    windowDays: RECORDS_WINDOW_DAYS,
    days,
    totals: { runs: totalRuns, costUsd: round6(totalCostUsd) },
    models: MODELS.map((m) => {
      const a = agg.get(m.key);
      return {
        key: m.key,
        label: m.label,
        vendor: m.vendor,
        runs: a.runs,
        okRuns: a.ok,
        p50LatencyMs: median(a.latencies),
        avgCostUsd: a.runs ? round6(a.costUsd / a.runs) : null,
        totalCostUsd: round6(a.costUsd),
        p50Series: a.byDay.map(median),
        runSeries: a.byDay.map((xs) => xs.length),
      };
    }),
  };
  memo = { at: Date.now(), body };
  return json(200, body);
}

export const handler = async (event) => {
  const path = event.rawPath ?? "/";
  try {
    if (path === "/api/public/records") return await records();
    return await info();
  } catch (err) {
    console.error("public route failed", err);
    return json(500, { message: "Internal error" });
  }
};
