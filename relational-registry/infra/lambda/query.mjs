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
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";

const { SSM_PREFIX, TABLE_NAME } = process.env;
const GLOBAL_DAILY_LIMIT = Number(process.env.GLOBAL_DAILY_LIMIT ?? 400);
const SEARCH_DAILY_LIMIT = 30; // per hashed caller IP, on top of the global cap
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

async function exec(stack, sql, transactionId, parameters) {
  const started = Date.now();
  const res = await data.send(
    new ExecuteStatementCommand({
      resourceArn: stack.clusterArn,
      secretArn: stack.secretArn,
      database: stack.database,
      sql,
      formatRecordsAs: "JSON",
      ...(transactionId ? { transactionId } : {}),
      ...(parameters ? { parameters } : {}),
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

const beginTx = async (stack) =>
  (
    await data.send(
      new BeginTransactionCommand({
        resourceArn: stack.clusterArn,
        secretArn: stack.secretArn,
        database: stack.database,
      })
    )
  ).transactionId;

const rollbackTx = (stack, transactionId) =>
  data
    .send(new RollbackTransactionCommand({ resourceArn: stack.clusterArn, secretArn: stack.secretArn, transactionId }))
    .catch(() => {});

async function withRollback(stack, fn) {
  const transactionId = await beginTx(stack);
  try {
    return await fn(transactionId);
  } finally {
    // Nothing an exhibit does inside a transaction is ever committed.
    await rollbackTx(stack, transactionId);
  }
}

// Two clerks at once: the concurrency exhibits hold two open transactions and
// always roll BOTH back, whatever the engine decided between them.
async function withTwoRollbacks(stack, fn) {
  const a = await beginTx(stack);
  const b = await beginTx(stack);
  try {
    return await fn(a, b);
  } finally {
    await Promise.all([rollbackTx(stack, a), rollbackTx(stack, b)]);
  }
}

// ---- the seal watch --------------------------------------------------------
// Server-authoritative wake bookkeeping: the first 202 of a resume stamps a
// pending marker; the first statement that lands afterwards measures the wake
// and files it in the wake log. The page's countdown runs off lastTouch.

const nowIso = () => new Date().toISOString();
const epoch = () => Math.floor(Date.now() / 1000);

const touchSeal = () =>
  ddb
    .send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: "SEAL", SK: "TOUCH" },
        UpdateExpression: "SET lastTouch = :t, #ttl = :ttl",
        ExpressionAttributeNames: { "#ttl": "ttl" },
        ExpressionAttributeValues: { ":t": nowIso(), ":ttl": epoch() + 2 * 86400 },
      })
    )
    .catch(() => {});

const markWakePending = () =>
  ddb
    .send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { PK: "SEAL", SK: "WAKE-PENDING", startedAt: Date.now(), ttl: epoch() + 3600 },
        // Only the FIRST 202 of a resume stamps the start; a stale marker
        // (a resume nobody followed up on) may be overwritten.
        ConditionExpression: "attribute_not_exists(startedAt) OR startedAt < :stale",
        ExpressionAttributeValues: { ":stale": Date.now() - 10 * 60_000 },
      })
    )
    .catch(() => {});

async function recordWakeIfAny() {
  const res = await ddb
    .send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { PK: "SEAL", SK: "WAKE-PENDING" },
        ReturnValues: "ALL_OLD",
      })
    )
    .catch(() => null);
  const started = res?.Attributes?.startedAt;
  if (!started || Date.now() - started > 10 * 60_000) return;
  const at = nowIso();
  await ddb
    .send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { PK: "WAKE#LOG", SK: at, at, ms: Date.now() - started, ttl: epoch() + 30 * 86400 },
      })
    )
    .catch(() => {});
}

// Search identity: second-from-last X-Forwarded-For entry. CloudFront appends
// the true viewer IP and API Gateway appends CloudFront's, so a client-sent
// XFF can never spoof this position through CloudFront.
function callerHash(event) {
  const parts = String(event.headers?.["x-forwarded-for"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ip = parts.length >= 2 ? parts[parts.length - 2] : parts[0] ?? event.requestContext?.http?.sourceIp ?? "unknown";
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

// ---- the exhibit catalog ---------------------------------------------------

const EXHIBITS = [
  {
    id: "wake",
    group: "serverless",
    title: "Touch the database",
    blurb:
      "Any statement unseals a paused cluster. If Aurora is at 0 ACU this call returns 202 while the engine resumes (~15s); the page times the wake for you.",
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
    blurb: "The seeded system of record: parcels, contractors, permits, inspections, all generated in-engine by the migration Lambda.",
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
    blurb: "Parcels → permits → inspections joined and aggregated: the everyday shape of a submit→review→decide system's reporting queries.",
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
    blurb: "Pass rates per licensed contractor, computed from inspections at query time; no denormalized copies to drift.",
    sql: ["SELECT * FROM registry.contractor_scorecard ORDER BY inspections DESC LIMIT 8;"],
    run: async (stack) => {
      const r = await exec(stack, "SELECT * FROM registry.contractor_scorecard ORDER BY inspections DESC LIMIT 8");
      return { kind: "rows", rows: r.rows, ms: r.ms };
    },
  },
  {
    id: "chain-of-title",
    group: "history",
    title: "Chain of title: every amendment on record",
    blurb:
      "A SECURITY DEFINER trigger files every superseded version of a permit into permit_history: who amended it, when, why, and the exact window each version was in force. This pulls the fullest chain in the book.",
    sql: [
      `SELECT p.permit_number, h.status, h.valuation, h.amended_by, h.note,
       h.valid_from::date, h.valid_to::date
  FROM registry.permit_history h JOIN registry.permits p ON p.id = h.permit_id
 WHERE h.permit_id = (…the fullest chain…) ORDER BY h.valid_from;`,
    ],
    run: async (stack) => {
      const r = await exec(
        stack,
        `WITH target AS (
           SELECT h.permit_id AS id FROM registry.permit_history h
            GROUP BY h.permit_id ORDER BY count(*) DESC, h.permit_id LIMIT 1
         )
         SELECT p.permit_number, h.status, h.valuation, h.amended_by AS desk, h.note,
                h.valid_from::date AS in_force_from, h.valid_to::date AS superseded_on
           FROM target t
           JOIN registry.permits p ON p.id = t.id
           JOIN registry.permit_history h ON h.permit_id = t.id
         UNION ALL
         SELECT p.permit_number, p.status, p.valuation, 'current record', 'the version in force today',
                p.last_amended_at::date, NULL
           FROM target t
           JOIN registry.permits p ON p.id = t.id
         ORDER BY in_force_from`
      );
      return { kind: "rows", rows: r.rows, ms: r.ms };
    },
  },
  {
    id: "as-of",
    group: "history",
    title: "The record as of any date",
    blurb:
      "Temporal reconstruction: the same permit read at four moments of its life. Each row is resolved from the history windows, so the registry can answer what it said on any date, not just today.",
    sql: [
      `SELECT label, coalesce(h.status, p.status), coalesce(h.valuation, p.valuation)
  FROM probes LEFT JOIN LATERAL (SELECT * FROM registry.permit_history h
 WHERE h.permit_id = p.id AND h.valid_from <= probe_at AND probe_at < h.valid_to) h ON true;`,
    ],
    run: async (stack) => {
      const r = await exec(
        stack,
        `WITH target AS (
           SELECT p.id, p.permit_number, p.submitted_at::timestamptz AS filed
             FROM registry.permits p
             JOIN registry.permit_history h ON h.permit_id = p.id
            GROUP BY p.id ORDER BY count(h.id) DESC, p.id LIMIT 1
         ),
         probes AS (
           SELECT v.label, v.offs FROM (VALUES
             ('shortly after filing', interval '5 days'),
             ('during review',        interval '35 days'),
             ('after the audit',      interval '65 days'),
             ('today',                NULL::interval)) v(label, offs)
         )
         SELECT t.permit_number,
                pr.label AS moment,
                coalesce((t.filed + pr.offs)::date, current_date) AS as_of,
                coalesce(h.status, p.status) AS status,
                coalesce(h.valuation, p.valuation) AS valuation,
                coalesce(h.note, 'current record') AS note
           FROM target t
           CROSS JOIN probes pr
           JOIN registry.permits p ON p.id = t.id
           LEFT JOIN LATERAL (
             SELECT * FROM registry.permit_history h
              WHERE h.permit_id = t.id
                AND h.valid_from <= coalesce(t.filed + pr.offs, now())
                AND coalesce(t.filed + pr.offs, now()) < h.valid_to
              ORDER BY h.valid_from LIMIT 1) h ON true
          ORDER BY as_of`
      );
      return { kind: "rows", rows: r.rows, ms: r.ms };
    },
  },
  {
    id: "amendment",
    group: "history",
    title: "Record an amendment, then void it",
    blurb:
      "A live amendment: SET LOCAL files the reason, a column-level UPDATE raises one valuation, and the trigger writes the superseded version into the history book. You watch the new history row inside the transaction, then the whole thing is voided.",
    sql: [
      "BEGIN;",
      "SET LOCAL registry.amendment_note = 'Corrected at the counter, then voided';",
      "UPDATE registry.permits SET valuation = valuation + 2500 WHERE id = …;  -- fires the trigger",
      "SELECT … FROM registry.permit_history …;  -- the trigger's entry, visible in-transaction",
      "ROLLBACK;  -- amendment and history entry both voided",
    ],
    run: async (stack) => {
      const target = "(SELECT min(id) FROM registry.permits WHERE status = 'issued')";
      const count = `SELECT count(*) AS chain_entries FROM registry.permit_history WHERE permit_id = ${target}`;
      const before = await exec(stack, count);
      const inTxn = await withRollback(stack, async (tx) => {
        await exec(stack, "SET LOCAL registry.amendment_note = 'Corrected at the counter, then voided'", tx);
        const upd = await exec(stack, `UPDATE registry.permits SET valuation = valuation + 2500 WHERE id = ${target}`, tx);
        const hist = await exec(
          stack,
          `SELECT status, valuation, amended_by, note, valid_from::date AS in_force_from, valid_to
             FROM registry.permit_history WHERE permit_id = ${target} ORDER BY id DESC LIMIT 1`,
          tx
        );
        return { updated: upd.updated, row: hist.rows[0] ?? null };
      });
      const after = await exec(stack, count);
      const beforeN = Number(before.rows[0]?.chain_entries ?? -1);
      const afterN = Number(after.rows[0]?.chain_entries ?? -2);
      return {
        kind: "sections",
        ok: inTxn.updated === 1 && !!inTxn.row && beforeN === afterN,
        ms: before.ms + after.ms,
        sections: [
          { label: "Before: entries in this permit's chain", rows: before.rows },
          inTxn.row
            ? {
                label: "Inside the transaction: the trigger's history entry, written by the engine",
                rows: [inTxn.row],
                okText: `UPDATE touched ${inTxn.updated} row; the superseded version was filed by ${inTxn.row.amended_by} with the SET LOCAL note attached.`,
              }
            : { label: "Inside the transaction", error: "No history entry appeared. The trigger did not fire." },
          {
            label: "After rollback",
            rows: after.rows,
            [beforeN === afterN ? "okText" : "error"]:
              beforeN === afterN
                ? "Voided: the amendment and its history entry both rolled back. The chain is exactly as it was."
                : "Chain length changed. This should not happen.",
          },
        ],
      };
    },
  },
  {
    id: "explain-plans",
    group: "plans",
    title: "EXPLAIN ANALYZE: index vs sequential scan",
    blurb:
      "The tract index versus turning every page: the same lookup by unique parcel number (index scan) and by street address, which stays deliberately unindexed (sequential scan). The planner's own output, live.",
    sql: [
      "EXPLAIN ANALYZE SELECT * FROM registry.parcels WHERE parcel_number = 'AP-01207';",
      "EXPLAIN ANALYZE SELECT * FROM registry.parcels WHERE address = '…';",
    ],
    run: async (stack) => {
      const indexed = await exec(stack, "EXPLAIN ANALYZE SELECT * FROM registry.parcels WHERE parcel_number = 'AP-01207'");
      const sample = await exec(stack, "SELECT address FROM registry.parcels WHERE id = 42");
      const addr = String(Object.values(sample.rows[0] ?? { v: "500 Alpenglow Ave" })[0]).replace(/'/g, "''");
      const seq = await exec(stack, `EXPLAIN ANALYZE SELECT * FROM registry.parcels WHERE address = '${addr}'`);
      const planText = (r) => r.rows.map((row) => Object.values(row)[0]).join("\n");
      return {
        kind: "plans",
        ms: indexed.ms + seq.ms,
        plans: [
          { label: "WHERE parcel_number = … (unique index)", plan: planText(indexed) },
          { label: `WHERE address = '${addr.replace(/''/g, "'")}' (no index)`, plan: planText(seq) },
        ],
      };
    },
  },
  {
    id: "fk-violation",
    group: "integrity",
    title: "Foreign key: orphan permit rejected",
    blurb:
      "An INSERT referencing a parcel that doesn't exist. The recorder refuses the instrument: referential integrity is enforced in the engine, not in hopeful application code.",
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
          note: "Attempted inside a transaction that is always rolled back; the registry is untouched either way.",
        };
      }),
  },
  {
    id: "check-violation",
    group: "integrity",
    title: "CHECK constraint: invalid inspection result",
    blurb: "An inspection with result 'maybe', outside the CHECK list ('pass','fail','partial'). Domain rules live next to the data.",
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
          note: "Rolled back regardless: nothing an exhibit does is ever committed.",
        };
      }),
  },
  {
    id: "txn-rollback",
    group: "integrity",
    title: "Transaction: all-or-nothing transfer",
    blurb:
      "A two-step ledger transfer where step 2 breaks a balance>=0 CHECK. The whole transaction rolls back; step 1 never happened. Atomicity, demonstrated.",
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
          { label: "step 1: credit general-fund +$9,000", failed: result.step1.failed, error: result.step1.error },
          { label: "step 2: debit permit-escrow −$9,000", failed: result.step2.failed, error: result.step2.error },
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
      "This very API connects as app_user, which may read the registry books and write the sandbox, nothing else. Watch its DELETE and DROP attempts die.",
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
    id: "lock-timeout",
    group: "concurrency",
    title: "Two clerks, one row: lock timeout",
    blurb:
      "Clerk A opens a transaction and pencils a change into a ledger row, holding its lock. Clerk B, allowed to wait two seconds at most, tries the same row. The engine's refusal is shown verbatim. Both transactions are rolled back.",
    sql: [
      "-- clerk A:  BEGIN; UPDATE sandbox.ledger SET balance = balance + 1 WHERE account = 'permit-escrow';  -- holds the row lock",
      "-- clerk B:  BEGIN; SET LOCAL lock_timeout = '2s';",
      "-- clerk B:  UPDATE sandbox.ledger SET balance = balance + 1 WHERE account = 'permit-escrow';  -- waits, then times out",
      "-- ROLLBACK both;",
    ],
    run: async (stack) =>
      withTwoRollbacks(stack, async (clerkA, clerkB) => {
        await exec(stack, "UPDATE sandbox.ledger SET balance = balance + 1 WHERE account = 'permit-escrow'", clerkA);
        await exec(stack, "SET LOCAL lock_timeout = '2s'", clerkB);
        const started = Date.now();
        const attempt = await execExpectError(
          stack,
          "UPDATE sandbox.ledger SET balance = balance + 1 WHERE account = 'permit-escrow'",
          clerkB
        );
        const waitedMs = Date.now() - started;
        return {
          kind: "sections",
          ok: attempt.failed && /lock timeout/i.test(attempt.error ?? ""),
          ms: waitedMs,
          sections: [
            { label: "Clerk A", okText: "Holds the row lock on permit-escrow inside an open transaction." },
            attempt.failed
              ? {
                  label: `Clerk B, after genuinely waiting ${(waitedMs / 1000).toFixed(1)}s in line`,
                  error: attempt.error,
                }
              : { label: "Clerk B", error: "UNEXPECTED: the second update went through while the row was locked." },
            {
              label: "Close of business",
              okText:
                "Both transactions rolled back. Row locks mean two clerks can never silently overwrite each other; the wait and the refusal are the engine keeping the book consistent.",
            },
          ],
        };
      }),
  },
  {
    id: "deadlock",
    group: "concurrency",
    title: "Deadlock: the engine picks a victim",
    blurb:
      "Clerk A locks the general fund, clerk B locks the escrow, then each reaches for the other's row at the same moment. Neither can ever proceed, so PostgreSQL detects the cycle in about a second, cancels one transaction, and says exactly why. Both are rolled back.",
    sql: [
      "-- clerk A:  UPDATE … WHERE account = 'general-fund';    -- locks row 1",
      "-- clerk B:  UPDATE … WHERE account = 'permit-escrow';   -- locks row 2",
      "-- simultaneously:",
      "-- clerk A:  UPDATE … WHERE account = 'permit-escrow';   -- waits for B",
      "-- clerk B:  UPDATE … WHERE account = 'general-fund';    -- waits for A → deadlock detected",
    ],
    run: async (stack) =>
      withTwoRollbacks(stack, async (clerkA, clerkB) => {
        await exec(stack, "UPDATE sandbox.ledger SET balance = balance + 1 WHERE account = 'general-fund'", clerkA);
        await exec(stack, "UPDATE sandbox.ledger SET balance = balance + 1 WHERE account = 'permit-escrow'", clerkB);
        const started = Date.now();
        const [a, b] = await Promise.all([
          execExpectError(stack, "UPDATE sandbox.ledger SET balance = balance + 1 WHERE account = 'permit-escrow'", clerkA),
          execExpectError(stack, "UPDATE sandbox.ledger SET balance = balance + 1 WHERE account = 'general-fund'", clerkB),
        ]);
        const detectMs = Date.now() - started;
        const victim = a.failed ? { who: "Clerk A", res: a } : { who: "Clerk B", res: b };
        const survivor = a.failed ? "Clerk B" : "Clerk A";
        const exactlyOne = a.failed !== b.failed;
        const isDeadlock = /deadlock/i.test(victim.res.error ?? "");
        return {
          kind: "sections",
          ok: exactlyOne && isDeadlock,
          ms: detectMs,
          sections: [
            {
              label: "The cycle",
              okText: "Clerk A holds general-fund and wants permit-escrow. Clerk B holds permit-escrow and wants general-fund. Neither can ever finish.",
            },
            exactlyOne
              ? { label: `${victim.who}, cancelled by the engine after ~${(detectMs / 1000).toFixed(1)}s`, error: victim.res.error }
              : { label: "Verdict", error: "Expected exactly one victim; the engine reported something else." },
            {
              label: "The survivor",
              okText: `${survivor}'s update went through the moment the victim was cancelled. Deadlock detection is the engine refereeing, not the application. Both transactions were then rolled back.`,
            },
          ],
        };
      }),
  },
  {
    id: "rls",
    group: "tenancy",
    title: "Row-level security: each desk its own district",
    blurb:
      "One case_files table, two district desks. A row-level security policy keyed to the transaction's desk assignment decides what app_user can see and write. Same role, same table, same query: different books.",
    sql: [
      "SET LOCAL app.clerk_district = 'north';  -- or 'south', or nothing",
      "SELECT case_number, parcel_number, subject, status FROM sandbox.case_files ORDER BY case_number;",
      "UPDATE sandbox.case_files SET district = 'south' WHERE case_number = 'CF-2026-0104';  -- north desk, moving a case out",
    ],
    run: async (stack) => {
      const list = "SELECT case_number, parcel_number, subject, status FROM sandbox.case_files ORDER BY case_number";
      const asDesk = (district, fn) =>
        withRollback(stack, async (tx) => {
          if (district) await exec(stack, `SET LOCAL app.clerk_district = '${district}'`, tx);
          return fn(tx);
        });
      const north = await asDesk("north", (tx) => exec(stack, list, tx));
      const south = await asDesk("south", (tx) => exec(stack, list, tx));
      const nobody = await asDesk(null, (tx) => exec(stack, list, tx));
      const smuggle = await asDesk("north", (tx) =>
        execExpectError(stack, "UPDATE sandbox.case_files SET district = 'south' WHERE case_number = 'CF-2026-0104'", tx)
      );
      return {
        kind: "sections",
        ok: north.rows.length > 0 && south.rows.length > 0 && nobody.rows.length === 0 && smuggle.failed,
        ms: north.ms + south.ms + nobody.ms,
        sections: [
          { label: `North desk sees ${north.rows.length} cases`, rows: north.rows },
          { label: `South desk sees ${south.rows.length} cases, from the identical query`, rows: south.rows },
          {
            label: "No desk assignment",
            [nobody.rows.length === 0 ? "okText" : "error"]:
              nobody.rows.length === 0
                ? "Zero rows. An unassigned session sees an empty book, not a default one."
                : "UNEXPECTED: rows visible without a desk assignment.",
          },
          smuggle.failed
            ? { label: "North desk tries to move a case into the south book", error: smuggle.error }
            : { label: "Cross-district write", error: "UNEXPECTED: the policy allowed the row to change districts." },
        ],
      };
    },
  },
  {
    id: "migrations",
    group: "schema",
    title: "Migration ledger",
    blurb: "Every schema change is an ordered, checksummed migration recorded in the database it shaped: rerunnable, auditable, boring on purpose.",
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

async function bumpSearchCounter(ipHash) {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `USAGE#${today}`, SK: `IP#${ipHash}` },
        UpdateExpression: "ADD #n :one SET #ttl = if_not_exists(#ttl, :ttl)",
        ConditionExpression: "attribute_not_exists(#n) OR #n < :limit",
        ExpressionAttributeNames: { "#n": "count", "#ttl": "ttl" },
        ExpressionAttributeValues: { ":one": 1, ":limit": SEARCH_DAILY_LIMIT, ":ttl": epoch() + 2 * 86400 },
        ReturnValues: "UPDATED_NEW",
      })
    );
    return Number(res.Attributes?.count ?? 0);
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return -1;
    throw err;
  }
}

// ---- routes ----------------------------------------------------------------

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

async function getStatus() {
  const [stack, used, touch] = await Promise.all([
    demoStack(),
    readGlobalCounter(),
    ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: "SEAL", SK: "TOUCH" } })).catch(() => null),
  ]);
  const usage = { used, limit: GLOBAL_DAILY_LIMIT };
  const lastTouch = touch?.Item?.lastTouch ?? null;
  if (!stack) return json(200, { deployed: false, usage, lastTouch });

  const clusterId = stack.clusterArn.split(":").pop();
  const [describe, metric] = await Promise.all([
    rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: clusterId })),
    cw.send(
      new GetMetricDataCommand({
        StartTime: new Date(Date.now() - 3 * 3600_000),
        EndTime: new Date(),
        ScanBy: "TimestampAscending",
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
  const series = metric.MetricDataResults?.[0];
  const timestamps = (series?.Timestamps ?? []).map((t) => new Date(t).getTime());
  const values = series?.Values ?? [];
  const currentAcu = values.length ? values[values.length - 1] : null;
  return json(200, {
    deployed: true,
    usage,
    lastTouch,
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
      acuSeries: { t: timestamps, v: values },
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
    await Promise.all([touchSeal(), recordWakeIfAny()]);
    return json(200, { id, ...result, totalMs: Date.now() - started, usage: { used, limit: GLOBAL_DAILY_LIMIT } });
  } catch (err) {
    if (isResuming(err)) {
      // Aurora is scaling up from 0 ACU. Tell the browser to retry — the
      // visible wait IS the scale-to-zero exhibit.
      await markWakePending();
      return json(202, { id, resuming: true, message: "Aurora is resuming from 0 ACU: retrying automatically…" });
    }
    console.error("exhibit failed", id, err);
    return json(502, { message: "The database rejected this exhibit unexpectedly; try again in a moment." });
  }
}

// ---- title search ----------------------------------------------------------
// The plank's only visitor-typed input, and it never becomes SQL text: the
// value is bound server-side as a Data API parameter, so the classic
// injection payloads arrive as harmless literals. The allowlist is wide
// enough to let ' OR '1'='1 through ON PURPOSE — watching it match nothing
// is the exhibit.

const SEARCH_SQL = `SELECT parcel_number, owner_name, address, zoning, acreage
  FROM registry.parcels
 WHERE owner_name ILIKE '%' || :q || '%'
 ORDER BY owner_name, parcel_number
 LIMIT 12`;

async function postSearch(event) {
  const stack = await demoStack();
  if (!stack)
    return json(503, {
      deployed: false,
      message: "The Aurora demo stack is torn down right now (idle ≈ $0), so the search desk is closed.",
    });

  let q = "";
  try {
    q = String(JSON.parse(event.body ?? "{}").q ?? "").trim();
  } catch {
    /* falls through to the charset check */
  }
  if (!/^[A-Za-z0-9 '.,=-]{2,40}$/.test(q))
    return json(400, {
      message:
        "Search text must be 2 to 40 characters: letters, digits, spaces, apostrophes, periods, commas, hyphens, or =. (Yes, = and quotes are allowed on purpose: they are bound as data, never as SQL.)",
    });

  const searchUsed = await bumpSearchCounter(callerHash(event));
  if (searchUsed === -1)
    return json(429, {
      message: `This address used all ${SEARCH_DAILY_LIMIT} searches for today. The canned exhibits stay open; the desk reopens at 00:00 UTC.`,
    });
  const used = await bumpGlobalCounter();
  if (used === -1)
    return json(429, { message: `The demo reached its shared daily budget of ${GLOBAL_DAILY_LIMIT} queries. Resets at 00:00 UTC.` });

  const parameters = [{ name: "q", value: { stringValue: q } }];
  const started = Date.now();
  try {
    const r = await exec(stack, SEARCH_SQL, undefined, parameters);
    // The plan proves the trigram index carried a fuzzy match over messy
    // human input. If EXPLAIN ever refuses a bound parameter, the rows still
    // tell the story, so it degrades to null instead of failing the search.
    let plan = null;
    try {
      const p = await exec(stack, `EXPLAIN ANALYZE ${SEARCH_SQL}`, undefined, parameters);
      plan = p.rows.map((row) => Object.values(row)[0]).join("\n");
    } catch {
      plan = null;
    }
    await Promise.all([touchSeal(), recordWakeIfAny()]);
    return json(200, {
      rows: r.rows,
      ms: r.ms,
      totalMs: Date.now() - started,
      plan,
      bound: { name: "q", type: "text", value: q },
      usage: { used, limit: GLOBAL_DAILY_LIMIT },
      searchUsage: { used: searchUsed, limit: SEARCH_DAILY_LIMIT },
    });
  } catch (err) {
    if (isResuming(err)) {
      await markWakePending();
      return json(202, { resuming: true, message: "Aurora is resuming from 0 ACU: retrying automatically…" });
    }
    console.error("search failed", err);
    return json(502, { message: "The database rejected this search unexpectedly; try again in a moment." });
  }
}

// The wake log lives in DynamoDB, so it survives teardown: past unsealings
// remain on the record even while the cluster itself is gone.
async function getWakes() {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": "WAKE#LOG" },
      ScanIndexForward: false,
      Limit: 40,
    })
  );
  return json(200, { wakes: (res.Items ?? []).map((i) => ({ at: i.at, ms: i.ms })) });
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method ?? "GET";
  const path = event.rawPath ?? "/";
  if (method === "GET" && path === "/api/status") return getStatus();
  if (method === "GET" && path === "/api/exhibits") return json(200, { exhibits: catalog() });
  if (method === "GET" && path === "/api/wakes") return getWakes();
  if (method === "POST" && path === "/api/search") return postSearch(event);
  if (method === "POST" && path.startsWith("/api/run/")) return postRun(event.pathParameters?.id ?? path.split("/").pop());
  return json(404, { message: "Not found" });
};
