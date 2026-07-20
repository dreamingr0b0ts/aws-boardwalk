// Canned-exhibit runner for the Alpenglow Land & Records Registry.
//
// There is deliberately NO user-supplied SQL anywhere in this plank: visitors
// pick an exhibit, the Lambda runs the fixed statements below over the RDS
// Data API as `app_user` — a Postgres role that can read the registry schema
// and write only the rollback sandbox. The cluster is discovered at runtime
// through SSM parameters the demo root writes; between demo windows the
// parameters are gone and every endpoint answers honestly with 503.
import {
  RDSDataClient,
  ExecuteStatementCommand,
  BeginTransactionCommand,
  CommitTransactionCommand,
  RollbackTransactionCommand,
} from "@aws-sdk/client-rds-data";
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import { RDSClient, DescribeDBClustersCommand } from "@aws-sdk/client-rds";
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient, ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const { SSM_PREFIX, TABLE_NAME } = process.env;
const GLOBAL_DAILY_LIMIT = Number(process.env.GLOBAL_DAILY_LIMIT ?? 400);
const MAX_ROWS = 60;

const data = new RDSDataClient({});
const ssm = new SSMClient({});
const rds = new RDSClient({});
const cw = new CloudWatchClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// ---- demo-stack discovery (SSM, cached briefly) ----------------------------

let stackCache = { at: 0, value: null };

async function demoStack() {
  if (Date.now() - stackCache.at < 30_000) return stackCache.value;
  const names = ["cluster-arn", "app-secret-arn", "database"].map((n) => `${SSM_PREFIX}/${n}`);
  const res = await ssm.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
  const get = (n) => res.Parameters?.find((p) => p.Name.endsWith(`/${n}`))?.Value;
  const value =
    res.Parameters?.length === names.length
      ? { clusterArn: get("cluster-arn"), secretArn: get("app-secret-arn"), database: get("database") }
      : null;
  stackCache = { at: Date.now(), value };
  return value;
}

// ---- Data API helpers ------------------------------------------------------

const isResuming = (err) =>
  /DatabaseResuming/i.test(err?.name ?? "") || /resum/i.test(err?.message ?? "");

async function exec(stack, sql, transactionId) {
  const started = Date.now();
  const res = await data.send(
    new ExecuteStatementCommand({
      resourceArn: stack.clusterArn,
      secretArn: stack.secretArn,
      database: stack.database,
      sql,
      formatRecordsAs: "JSON",
      ...(transactionId ? { transactionId } : {}),
    })
  );
  return {
    ms: Date.now() - started,
    rows: res.formattedRecords ? JSON.parse(res.formattedRecords).slice(0, MAX_ROWS) : [],
    updated: res.numberOfRecordsUpdated ?? 0,
  };
}

// Postgres errors surface as Data API exceptions whose message carries the
// engine's own words — for the integrity exhibits that message IS the result.
async function execExpectError(stack, sql, transactionId) {
  try {
    await exec(stack, sql, transactionId);
    return { failed: false, error: null };
  } catch (err) {
    if (isResuming(err)) throw err;
    return { failed: true, error: String(err.message ?? err.name).replace(/\s+/g, " ").trim() };
  }
}

async function withRollback(stack, fn) {
  const { transactionId } = await data.send(
    new BeginTransactionCommand({
      resourceArn: stack.clusterArn,
      secretArn: stack.secretArn,
      database: stack.database,
    })
  );
  try {
    return await fn(transactionId);
  } finally {
    // Nothing an exhibit does inside a transaction is ever committed.
    await data
      .send(new RollbackTransactionCommand({ resourceArn: stack.clusterArn, secretArn: stack.secretArn, transactionId }))
      .catch(() => {});
  }
}

// ---- the exhibit catalog ---------------------------------------------------

const EXHIBITS = [
  {
    id: "wake",
    group: "serverless",
    title: "Touch the database",
    blurb:
      "Any statement wakes a paused cluster. If Aurora is at 0 ACU this call returns 202 while the engine resumes (~15s) — the page times the wake for you.",
    sql: ["SELECT now() AS server_time, current_user, version() AS postgres;"],
    run: async (stack) => {
      const r = await exec(stack, "SELECT now() AS server_time, current_user AS connected_as, version() AS postgres");
      return { kind: "rows", rows: r.rows, ms: r.ms };
    },
  },
  {
    id: "counts",
    group: "read",
    title: "Registry row counts",
    blurb: "The seeded system of record: parcels, contractors, permits, inspections — all generated in-engine by the migration Lambda.",
    sql: ["SELECT (SELECT count(*) FROM registry.parcels) AS parcels, …;"],
    run: async (stack) => {
      const r = await exec(
        stack,
        `SELECT (SELECT count(*) FROM registry.parcels)      AS parcels,
                (SELECT count(*) FROM registry.contractors)  AS contractors,
                (SELECT count(*) FROM registry.permits)      AS permits,
                (SELECT count(*) FROM registry.inspections)  AS inspections`
      );
      return { kind: "rows", rows: r.rows, ms: r.ms };
    },
  },
  {
    id: "join-activity",
    group: "read",
    title: "Three-table join: busiest parcels",
    blurb: "Parcels → permits → inspections joined and aggregated — the everyday shape of a submit→review→decide system's reporting queries.",
    sql: [
      `SELECT p.parcel_number, p.owner_name, count(DISTINCT pe.id) AS permits,
       sum(pe.valuation) AS total_valuation, max(i.inspected_at) AS last_inspection
  FROM registry.parcels p
  JOIN registry.permits pe ON pe.parcel_id = p.id
  LEFT JOIN registry.inspections i ON i.permit_id = pe.id
 GROUP BY p.id ORDER BY permits DESC LIMIT 8;`,
    ],
    run: async (stack) => {
      const r = await exec(
        stack,
        `SELECT p.parcel_number, p.owner_name, p.zoning,
                count(DISTINCT pe.id)                 AS permits,
                to_char(sum(pe.valuation), 'FM$999,999,990') AS total_valuation,
                max(i.inspected_at)                   AS last_inspection
           FROM registry.parcels p
           JOIN registry.permits pe ON pe.parcel_id = p.id
           LEFT JOIN registry.inspections i ON i.permit_id = pe.id
          GROUP BY p.id, p.parcel_number, p.owner_name, p.zoning
          ORDER BY permits DESC, total_valuation DESC
          LIMIT 8`
      );
      return { kind: "rows", rows: r.rows, ms: r.ms };
    },
  },
  {
    id: "view-throughput",
    group: "read",
    title: "Reporting view: permit throughput",
    blurb: "A plain SQL view rolls the permits table into the monthly throughput report a program manager actually asks for.",
    sql: ["SELECT * FROM registry.permit_throughput ORDER BY month DESC, permit_type LIMIT 14;"],
    run: async (stack) => {
      const r = await exec(stack, "SELECT * FROM registry.permit_throughput ORDER BY month DESC, permit_type LIMIT 14");
      return { kind: "rows", rows: r.rows, ms: r.ms };
    },
  },
  {
    id: "view-contractors",
    group: "read",
    title: "Reporting view: contractor scorecard",
    blurb: "Pass rates per licensed contractor, computed from inspections at query time — no denormalized copies to drift.",
    sql: ["SELECT * FROM registry.contractor_scorecard ORDER BY inspections DESC LIMIT 8;"],
    run: async (stack) => {
      const r = await exec(stack, "SELECT * FROM registry.contractor_scorecard ORDER BY inspections DESC LIMIT 8");
      return { kind: "rows", rows: r.rows, ms: r.ms };
    },
  },
  {
    id: "explain-plans",
    group: "plans",
    title: "EXPLAIN ANALYZE: index vs sequential scan",
    blurb:
      "The same lookup twice: by unique parcel number (index scan) and by unindexed owner name (sequential scan). The planner's own output, live.",
    sql: [
      "EXPLAIN ANALYZE SELECT * FROM registry.parcels WHERE parcel_number = 'AP-01207';",
      "EXPLAIN ANALYZE SELECT * FROM registry.parcels WHERE owner_name = '…';",
    ],
    run: async (stack) => {
      const indexed = await exec(stack, "EXPLAIN ANALYZE SELECT * FROM registry.parcels WHERE parcel_number = 'AP-01207'");
      const owner = await exec(stack, "SELECT owner_name FROM registry.parcels WHERE id = 42");
      const name = String(Object.values(owner.rows[0] ?? { v: "Alex Rivera" })[0]).replace(/'/g, "''");
      const seq = await exec(stack, `EXPLAIN ANALYZE SELECT * FROM registry.parcels WHERE owner_name = '${name}'`);
      const planText = (r) => r.rows.map((row) => Object.values(row)[0]).join("\n");
      return {
        kind: "plans",
        ms: indexed.ms + seq.ms,
        plans: [
          { label: "WHERE parcel_number = … (unique index)", plan: planText(indexed) },
          { label: `WHERE owner_name = '${name.replace(/''/g, "'")}' (no index)`, plan: planText(seq) },
        ],
      };
    },
  },
  {
    id: "fk-violation",
    group: "integrity",
    title: "Foreign key: orphan permit rejected",
    blurb:
      "An INSERT referencing a parcel that doesn't exist. The database itself refuses — referential integrity is enforced in the engine, not in hopeful application code.",
    sql: ["INSERT INTO registry.permits (…, parcel_id, …) VALUES (…, 9999999, …);  -- no such parcel"],
    run: async (stack) =>
      withRollback(stack, async (tx) => {
        const attempt = await execExpectError(
          stack,
          `INSERT INTO registry.permits (permit_number, parcel_id, permit_type, status, valuation, submitted_at)
           VALUES ('BP-2026-99999', 9999999, 'building', 'submitted', 12000, current_date)`,
          tx
        );
        return {
          kind: "integrity",
          verdict: attempt.failed ? "rejected by the engine" : "UNEXPECTEDLY ACCEPTED",
          ok: attempt.failed,
          error: attempt.error,
          note: "Attempted inside a transaction that is always rolled back — the registry is untouched either way.",
        };
      }),
  },
  {
    id: "check-violation",
    group: "integrity",
    title: "CHECK constraint: invalid inspection result",
    blurb: "An inspection with result 'maybe' — outside the CHECK list ('pass','fail','partial'). Domain rules live next to the data.",
    sql: ["INSERT INTO registry.inspections (…, result, …) VALUES (…, 'maybe', …);"],
    run: async (stack) =>
      withRollback(stack, async (tx) => {
        const attempt = await execExpectError(
          stack,
          `INSERT INTO registry.inspections (permit_id, inspection_type, result, inspected_at)
           VALUES ((SELECT min(id) FROM registry.permits), 'final', 'maybe', current_date)`,
          tx
        );
        return {
          kind: "integrity",
          verdict: attempt.failed ? "rejected by the engine" : "UNEXPECTEDLY ACCEPTED",
          ok: attempt.failed,
          error: attempt.error,
          note: "Rolled back regardless — nothing an exhibit does is ever committed.",
        };
      }),
  },
  {
    id: "txn-rollback",
    group: "integrity",
    title: "Transaction: all-or-nothing transfer",
    blurb:
      "A two-step ledger transfer where step 2 breaks a balance>=0 CHECK. The whole transaction rolls back — step 1 never happened. Atomicity, demonstrated.",
    sql: [
      "BEGIN;",
      "UPDATE sandbox.ledger SET balance = balance + 9000 WHERE account = 'general-fund';  -- succeeds",
      "UPDATE sandbox.ledger SET balance = balance - 9000 WHERE account = 'permit-escrow'; -- CHECK fails",
      "ROLLBACK;  -- automatic: both steps undone",
    ],
    run: async (stack) => {
      const before = await exec(stack, "SELECT account, balance FROM sandbox.ledger ORDER BY account");
      const result = await withRollback(stack, async (tx) => {
        const step1 = await execExpectError(
          stack,
          "UPDATE sandbox.ledger SET balance = balance + 9000 WHERE account = 'general-fund'",
          tx
        );
        const step2 = await execExpectError(
          stack,
          "UPDATE sandbox.ledger SET balance = balance - 9000 WHERE account = 'permit-escrow'",
          tx
        );
        return { step1, step2 };
      });
      const after = await exec(stack, "SELECT account, balance FROM sandbox.ledger ORDER BY account");
      const unchanged = JSON.stringify(before.rows) === JSON.stringify(after.rows);
      return {
        kind: "txn",
        ok: !result.step1.failed && result.step2.failed && unchanged,
        steps: [
          { label: "step 1 — credit general-fund +$9,000", failed: result.step1.failed, error: result.step1.error },
          { label: "step 2 — debit permit-escrow −$9,000", failed: result.step2.failed, error: result.step2.error },
        ],
        before: before.rows,
        after: after.rows,
        unchanged,
        ms: before.ms + after.ms,
      };
    },
  },
  {
    id: "least-privilege",
    group: "integrity",
    title: "Least privilege: the API's own role, fenced",
    blurb:
      "This very API connects as app_user, which can read the registry and write the sandbox — nothing else. Watch its DELETE and DROP attempts die.",
    sql: ["DELETE FROM registry.permits WHERE id = 1;", "DROP TABLE registry.inspections;"],
    run: async (stack) => {
      const del = await execExpectError(stack, "DELETE FROM registry.permits WHERE id = 1");
      const drop = await execExpectError(stack, "DROP TABLE registry.inspections");
      return {
        kind: "denials",
        ok: del.failed && drop.failed,
        attempts: [
          { label: "DELETE FROM registry.permits", failed: del.failed, error: del.error },
          { label: "DROP TABLE registry.inspections", failed: drop.failed, error: drop.error },
        ],
      };
    },
  },
  {
    id: "migrations",
    group: "schema",
    title: "Migration ledger",
    blurb: "Every schema change is an ordered, checksummed migration recorded in the database it shaped — rerunnable, auditable, boring on purpose.",
    sql: ["SELECT id, left(checksum, 12) AS checksum, applied_at FROM registry.schema_migrations ORDER BY id;"],
    run: async (stack) => {
      const r = await exec(
        stack,
        "SELECT id, left(checksum, 12) || '…' AS checksum, applied_at FROM registry.schema_migrations ORDER BY id"
      );
      return { kind: "rows", rows: r.rows, ms: r.ms };
    },
  },
];

// ---- usage counter ---------------------------------------------------------

async function bumpGlobalCounter() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `USAGE#${today}`, SK: "GLOBAL" },
        UpdateExpression: "ADD #n :one SET #ttl = if_not_exists(#ttl, :ttl)",
        ConditionExpression: "attribute_not_exists(#n) OR #n < :limit",
        ExpressionAttributeNames: { "#n": "count", "#ttl": "ttl" },
        ExpressionAttributeValues: { ":one": 1, ":limit": GLOBAL_DAILY_LIMIT, ":ttl": Math.floor(Date.now() / 1000) + 2 * 86400 },
        ReturnValues: "UPDATED_NEW",
      })
    );
    return Number(res.Attributes?.count ?? 0);
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return -1;
    throw err;
  }
}

async function readGlobalCounter() {
  const today = new Date().toISOString().slice(0, 10);
  const res = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: `USAGE#${today}`, SK: "GLOBAL" } }));
  return Number(res.Item?.count ?? 0);
}

// ---- routes ----------------------------------------------------------------

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

async function getStatus() {
  const [stack, used] = await Promise.all([demoStack(), readGlobalCounter()]);
  const usage = { used, limit: GLOBAL_DAILY_LIMIT };
  if (!stack) return json(200, { deployed: false, usage });

  const clusterId = stack.clusterArn.split(":").pop();
  const [describe, metric] = await Promise.all([
    rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: clusterId })),
    cw.send(
      new GetMetricDataCommand({
        StartTime: new Date(Date.now() - 15 * 60_000),
        EndTime: new Date(),
        ScanBy: "TimestampDescending",
        MetricDataQueries: [
          {
            Id: "acu",
            MetricStat: {
              Metric: {
                Namespace: "AWS/RDS",
                MetricName: "ServerlessDatabaseCapacity",
                Dimensions: [{ Name: "DBClusterIdentifier", Value: clusterId }],
              },
              Period: 60,
              Stat: "Average",
            },
          },
        ],
      })
    ),
  ]);
  const c = describe.DBClusters?.[0] ?? {};
  const acuSeries = metric.MetricDataResults?.[0];
  const currentAcu = acuSeries?.Values?.length ? acuSeries.Values[0] : null;
  return json(200, {
    deployed: true,
    usage,
    cluster: {
      id: clusterId,
      status: c.Status ?? "unknown",
      engine: `${c.Engine} ${c.EngineVersion}`,
      minAcu: c.ServerlessV2ScalingConfiguration?.MinCapacity ?? null,
      maxAcu: c.ServerlessV2ScalingConfiguration?.MaxCapacity ?? null,
      autoPauseSeconds: c.ServerlessV2ScalingConfiguration?.SecondsUntilAutoPause ?? null,
      encrypted: c.StorageEncrypted === true,
      currentAcu,
      paused: currentAcu === 0,
    },
  });
}

const catalog = () =>
  EXHIBITS.map(({ id, group, title, blurb, sql }) => ({ id, group, title, blurb, sql }));

async function postRun(id) {
  const exhibit = EXHIBITS.find((e) => e.id === id);
  if (!exhibit) return json(404, { message: `No such exhibit: ${id}` });

  const stack = await demoStack();
  if (!stack)
    return json(503, {
      deployed: false,
      message: "The Aurora demo stack is torn down right now (idle ≈ $0). The persisted evidence report below shows its last full cycle.",
    });

  const used = await bumpGlobalCounter();
  if (used === -1)
    return json(429, { message: `The demo reached its shared daily budget of ${GLOBAL_DAILY_LIMIT} queries. Resets at 00:00 UTC.` });

  const started = Date.now();
  try {
    const result = await exhibit.run(stack);
    return json(200, { id, ...result, totalMs: Date.now() - started, usage: { used, limit: GLOBAL_DAILY_LIMIT } });
  } catch (err) {
    if (isResuming(err)) {
      // Aurora is scaling up from 0 ACU. Tell the browser to retry — the
      // visible wait IS the scale-to-zero exhibit.
      return json(202, { id, resuming: true, message: "Aurora is resuming from 0 ACU — retrying automatically…" });
    }
    console.error("exhibit failed", id, err);
    return json(502, { message: "The database rejected this exhibit unexpectedly — try again in a moment." });
  }
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method ?? "GET";
  const path = event.rawPath ?? "/";
  if (method === "GET" && path === "/api/status") return getStatus();
  if (method === "GET" && path === "/api/exhibits") return json(200, { exhibits: catalog() });
  if (method === "POST" && path.startsWith("/api/run/")) return postRun(event.pathParameters?.id ?? path.split("/").pop());
  return json(404, { message: "Not found" });
};
