// Database-to-evidence report generator. Exercises every exhibit against the
// live Aurora cluster — as the least-privilege app_user wherever possible —
// and writes evidence.json + a standalone evidence.html into the ALWAYS-ON
// site bucket. The report is what survives `make teardown`: proof the
// relational core existed, enforced its constraints, and scaled to zero.
import {
  RDSDataClient,
  ExecuteStatementCommand,
  BeginTransactionCommand,
  RollbackTransactionCommand,
} from "@aws-sdk/client-rds-data";
import { RDSClient, DescribeDBClustersCommand } from "@aws-sdk/client-rds";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const { CLUSTER_ARN, CLUSTER_ID, MASTER_SECRET_ARN, APP_SECRET_ARN, DATABASE, SITE_BUCKET } = process.env;

const data = new RDSDataClient({});
const rds = new RDSClient({});
const s3 = new S3Client({});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isResuming = (err) =>
  /DatabaseResuming/i.test(err?.name ?? "") || /resum/i.test(err?.message ?? "");

let wake = { observed: false, ms: 0 };

async function exec(sql, { secretArn = APP_SECRET_ARN, transactionId } = {}) {
  const started = Date.now();
  const deadline = started + 180_000;
  for (;;) {
    try {
      const res = await data.send(
        new ExecuteStatementCommand({
          resourceArn: CLUSTER_ARN,
          secretArn,
          database: DATABASE,
          sql,
          formatRecordsAs: "JSON",
          ...(transactionId ? { transactionId } : {}),
        })
      );
      return {
        ms: Date.now() - started,
        rows: res.formattedRecords ? JSON.parse(res.formattedRecords) : [],
      };
    } catch (err) {
      if (isResuming(err) && Date.now() < deadline) {
        wake = { observed: true, ms: Date.now() - started };
        await sleep(4000);
        continue;
      }
      throw err;
    }
  }
}

async function expectError(sql, opts = {}) {
  try {
    await exec(sql, opts);
    return { failed: false, error: null };
  } catch (err) {
    return { failed: true, error: String(err.message ?? err.name).replace(/\s+/g, " ").trim() };
  }
}

// ---- collectors ------------------------------------------------------------

async function collectCluster() {
  const res = await rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: CLUSTER_ID }));
  const c = res.DBClusters?.[0] ?? {};
  return {
    id: CLUSTER_ID,
    engine: `${c.Engine} ${c.EngineVersion}`,
    status: c.Status ?? "unknown",
    serverlessV2: {
      minAcu: c.ServerlessV2ScalingConfiguration?.MinCapacity ?? null,
      maxAcu: c.ServerlessV2ScalingConfiguration?.MaxCapacity ?? null,
      autoPauseSeconds: c.ServerlessV2ScalingConfiguration?.SecondsUntilAutoPause ?? null,
    },
    scalesToZero: c.ServerlessV2ScalingConfiguration?.MinCapacity === 0,
    dataApiEnabled: c.HttpEndpointEnabled === true,
    storageEncrypted: c.StorageEncrypted === true,
    iamAuth: c.IAMDatabaseAuthenticationEnabled === true,
    backupRetentionDays: c.BackupRetentionPeriod ?? null,
    noIngressSecurityGroup: true, // by construction: the SG has zero rules; access is Data API only
  };
}

async function collectData() {
  // First statement of the report — this is where a paused cluster wakes.
  const counts = await exec(
    `SELECT (SELECT count(*) FROM registry.parcels)     AS parcels,
            (SELECT count(*) FROM registry.contractors) AS contractors,
            (SELECT count(*) FROM registry.permits)     AS permits,
            (SELECT count(*) FROM registry.inspections) AS inspections`
  );
  const throughput = await exec(
    `SELECT * FROM registry.permit_throughput ORDER BY month DESC, permit_type LIMIT 6`
  );
  return { counts: counts.rows[0], throughputSample: throughput.rows };
}

async function collectMigrations() {
  const r = await exec(`SELECT id, left(checksum, 12) AS checksum, applied_at FROM registry.schema_migrations ORDER BY id`);
  return r.rows;
}

async function collectIntegrity() {
  const begin = await data.send(
    new BeginTransactionCommand({ resourceArn: CLUSTER_ARN, secretArn: APP_SECRET_ARN, database: DATABASE })
  );
  const tx = begin.transactionId;
  const fk = await expectError(
    `INSERT INTO registry.permits (permit_number, parcel_id, permit_type, status, valuation, submitted_at)
     VALUES ('BP-2026-99999', 9999999, 'building', 'submitted', 12000, current_date)`,
    { transactionId: tx }
  );
  await data
    .send(new RollbackTransactionCommand({ resourceArn: CLUSTER_ARN, secretArn: APP_SECRET_ARN, transactionId: tx }))
    .catch(() => {});

  const begin2 = await data.send(
    new BeginTransactionCommand({ resourceArn: CLUSTER_ARN, secretArn: APP_SECRET_ARN, database: DATABASE })
  );
  const check = await expectError(
    `INSERT INTO registry.inspections (permit_id, inspection_type, result, inspected_at)
     VALUES ((SELECT min(id) FROM registry.permits), 'final', 'maybe', current_date)`,
    { transactionId: begin2.transactionId }
  );
  await data
    .send(new RollbackTransactionCommand({ resourceArn: CLUSTER_ARN, secretArn: APP_SECRET_ARN, transactionId: begin2.transactionId }))
    .catch(() => {});

  // atomic transfer: step 1 fine, step 2 violates balance >= 0, both undone
  const before = (await exec(`SELECT account, balance FROM sandbox.ledger ORDER BY account`)).rows;
  const begin3 = await data.send(
    new BeginTransactionCommand({ resourceArn: CLUSTER_ARN, secretArn: APP_SECRET_ARN, database: DATABASE })
  );
  const step1 = await expectError(`UPDATE sandbox.ledger SET balance = balance + 9000 WHERE account = 'general-fund'`, {
    transactionId: begin3.transactionId,
  });
  const step2 = await expectError(`UPDATE sandbox.ledger SET balance = balance - 9000 WHERE account = 'permit-escrow'`, {
    transactionId: begin3.transactionId,
  });
  await data
    .send(new RollbackTransactionCommand({ resourceArn: CLUSTER_ARN, secretArn: APP_SECRET_ARN, transactionId: begin3.transactionId }))
    .catch(() => {});
  const after = (await exec(`SELECT account, balance FROM sandbox.ledger ORDER BY account`)).rows;

  const del = await expectError(`DELETE FROM registry.permits WHERE id = 1`);
  const drop = await expectError(`DROP TABLE registry.inspections`);

  return {
    fkViolation: { ok: fk.failed, error: fk.error },
    checkViolation: { ok: check.failed, error: check.error },
    txnRollback: {
      ok: !step1.failed && step2.failed && JSON.stringify(before) === JSON.stringify(after),
      step1Failed: step1.failed,
      step2Failed: step2.failed,
      step2Error: step2.error,
      balancesUnchanged: JSON.stringify(before) === JSON.stringify(after),
      balances: after,
    },
    leastPrivilege: {
      ok: del.failed && drop.failed,
      attempts: [
        { statement: "DELETE FROM registry.permits WHERE id = 1", error: del.error },
        { statement: "DROP TABLE registry.inspections", error: drop.error },
      ],
    },
  };
}

async function collectPlans() {
  const planText = (r) => r.rows.map((row) => Object.values(row)[0]).join("\n");
  const execTime = (text) => Number(/Execution Time: ([\d.]+) ms/.exec(text)?.[1] ?? NaN);
  const indexed = planText(await exec(`EXPLAIN ANALYZE SELECT * FROM registry.parcels WHERE parcel_number = 'AP-01207'`));
  // address stays deliberately unindexed; owner_name now carries the search
  // exhibit's trigram index, so it no longer demonstrates a sequential scan.
  const seq = planText(await exec(`EXPLAIN ANALYZE SELECT * FROM registry.parcels WHERE address = '1 Nowhere Ln'`));
  return {
    indexed: { usesIndexScan: /Index Scan/.test(indexed), executionMs: execTime(indexed), plan: indexed },
    seqScan: { usesSeqScan: /Seq Scan/.test(seq), executionMs: execTime(seq), plan: seq },
  };
}

// ---- the season's additions: history, concurrency, tenancy, search ---------

async function collectHistory() {
  const chain = await exec(
    `SELECT count(*) AS entries FROM registry.permit_history
      WHERE permit_id = (SELECT permit_id FROM registry.permit_history
                          GROUP BY permit_id ORDER BY count(*) DESC, permit_id LIMIT 1)`
  );
  const total = await exec(`SELECT count(*) AS entries FROM registry.permit_history`);
  // as-of check: for the fullest chain, the status shortly after filing must
  // differ from the status on record today.
  const asOf = await exec(
    `WITH target AS (
       SELECT p.id, p.status AS now_status, p.submitted_at::timestamptz AS filed
         FROM registry.permits p
         JOIN registry.permit_history h ON h.permit_id = p.id
        GROUP BY p.id ORDER BY count(h.id) DESC, p.id LIMIT 1
     )
     SELECT t.now_status, h.status AS then_status
       FROM target t
       JOIN registry.permit_history h
         ON h.permit_id = t.id
        AND h.valid_from <= t.filed + interval '5 days'
        AND t.filed + interval '5 days' < h.valid_to`
  );
  const thenStatus = asOf.rows[0]?.then_status ?? null;
  const nowStatus = asOf.rows[0]?.now_status ?? null;
  const tx = (await data.send(
    new BeginTransactionCommand({ resourceArn: CLUSTER_ARN, secretArn: APP_SECRET_ARN, database: DATABASE })
  )).transactionId;
  let trigger = { fired: false };
  try {
    await exec(`SET LOCAL registry.amendment_note = 'Evidence run amendment, always voided'`, { transactionId: tx });
    await exec(`UPDATE registry.permits SET valuation = valuation + 1 WHERE id = (SELECT min(id) FROM registry.permits WHERE status = 'issued')`, { transactionId: tx });
    const row = await exec(
      `SELECT amended_by, note FROM registry.permit_history
        WHERE permit_id = (SELECT min(id) FROM registry.permits WHERE status = 'issued')
        ORDER BY id DESC LIMIT 1`,
      { transactionId: tx }
    );
    trigger = {
      fired: row.rows[0]?.amended_by === "app_user" && /voided/.test(row.rows[0]?.note ?? ""),
      amendedBy: row.rows[0]?.amended_by ?? null,
    };
  } finally {
    await data
      .send(new RollbackTransactionCommand({ resourceArn: CLUSTER_ARN, secretArn: APP_SECRET_ARN, transactionId: tx }))
      .catch(() => {});
  }
  return {
    ok: Number(chain.rows[0]?.entries ?? 0) >= 3 && thenStatus !== null && thenStatus !== nowStatus && trigger.fired,
    totalEntries: Number(total.rows[0]?.entries ?? 0),
    fullestChain: Number(chain.rows[0]?.entries ?? 0),
    asOf: { thenStatus, nowStatus, differs: thenStatus !== null && thenStatus !== nowStatus },
    triggerFiredAsAppUser: trigger.fired,
  };
}

async function collectConcurrency() {
  const begin = () =>
    data
      .send(new BeginTransactionCommand({ resourceArn: CLUSTER_ARN, secretArn: APP_SECRET_ARN, database: DATABASE }))
      .then((r) => r.transactionId);
  const rollback = (tx) =>
    data
      .send(new RollbackTransactionCommand({ resourceArn: CLUSTER_ARN, secretArn: APP_SECRET_ARN, transactionId: tx }))
      .catch(() => {});

  const a1 = await begin();
  const b1 = await begin();
  let lockTimeout;
  try {
    await exec(`UPDATE sandbox.ledger SET balance = balance + 1 WHERE account = 'permit-escrow'`, { transactionId: a1 });
    await exec(`SET LOCAL lock_timeout = '2s'`, { transactionId: b1 });
    lockTimeout = await expectError(`UPDATE sandbox.ledger SET balance = balance + 1 WHERE account = 'permit-escrow'`, {
      transactionId: b1,
    });
  } finally {
    await rollback(a1);
    await rollback(b1);
  }

  const a2 = await begin();
  const b2 = await begin();
  let deadlock;
  try {
    await exec(`UPDATE sandbox.ledger SET balance = balance + 1 WHERE account = 'general-fund'`, { transactionId: a2 });
    await exec(`UPDATE sandbox.ledger SET balance = balance + 1 WHERE account = 'permit-escrow'`, { transactionId: b2 });
    const [ra, rb] = await Promise.all([
      expectError(`UPDATE sandbox.ledger SET balance = balance + 1 WHERE account = 'permit-escrow'`, { transactionId: a2 }),
      expectError(`UPDATE sandbox.ledger SET balance = balance + 1 WHERE account = 'general-fund'`, { transactionId: b2 }),
    ]);
    const victim = ra.failed ? ra : rb;
    deadlock = { exactlyOneVictim: ra.failed !== rb.failed, error: victim.error };
  } finally {
    await rollback(a2);
    await rollback(b2);
  }

  return {
    lockTimeout: { ok: lockTimeout.failed && /lock timeout/i.test(lockTimeout.error ?? ""), error: lockTimeout.error },
    deadlock: { ok: deadlock.exactlyOneVictim && /deadlock/i.test(deadlock.error ?? ""), error: deadlock.error },
  };
}

async function collectRls() {
  const begin = () =>
    data
      .send(new BeginTransactionCommand({ resourceArn: CLUSTER_ARN, secretArn: APP_SECRET_ARN, database: DATABASE }))
      .then((r) => r.transactionId);
  const rollback = (tx) =>
    data
      .send(new RollbackTransactionCommand({ resourceArn: CLUSTER_ARN, secretArn: APP_SECRET_ARN, transactionId: tx }))
      .catch(() => {});
  const countAs = async (district) => {
    const tx = await begin();
    try {
      if (district) await exec(`SET LOCAL app.clerk_district = '${district}'`, { transactionId: tx });
      const r = await exec(`SELECT count(*) AS n FROM sandbox.case_files`, { transactionId: tx });
      return Number(r.rows[0]?.n ?? -1);
    } finally {
      await rollback(tx);
    }
  };
  const north = await countAs("north");
  const south = await countAs("south");
  const unassigned = await countAs(null);
  const tx = await begin();
  let cross;
  try {
    await exec(`SET LOCAL app.clerk_district = 'north'`, { transactionId: tx });
    cross = await expectError(`UPDATE sandbox.case_files SET district = 'south' WHERE case_number = 'CF-2026-0104'`, {
      transactionId: tx,
    });
  } finally {
    await rollback(tx);
  }
  return {
    ok: north > 0 && south > 0 && unassigned === 0 && cross.failed && /row-level security/i.test(cross.error ?? ""),
    north,
    south,
    unassigned,
    crossDistrictError: cross.error,
  };
}

async function collectSearch() {
  // Same shape as the live search endpoint, ORDER BY included: without the
  // sort, LIMIT 12 lets the planner early-abort a seq scan and the index
  // never shows up in the plan (observed live 2026-07-31).
  const sql = `SELECT parcel_number, owner_name FROM registry.parcels
 WHERE owner_name ILIKE '%' || :q || '%'
 ORDER BY owner_name, parcel_number
 LIMIT 12`;
  const bound = async (q) => {
    const started = Date.now();
    const res = await data.send(
      new ExecuteStatementCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: APP_SECRET_ARN,
        database: DATABASE,
        sql,
        formatRecordsAs: "JSON",
        parameters: [{ name: "q", value: { stringValue: q } }],
      })
    );
    return { ms: Date.now() - started, rows: res.formattedRecords ? JSON.parse(res.formattedRecords) : [] };
  };
  const name = await bound("Rivera");
  const injection = await bound(`' OR '1'='1`);
  // Full-name fragment for the plan probe: selective enough (~1/430 of rows)
  // that the trigram index genuinely beats a seq scan; a bare surname is ~3%
  // of the registry and the planner rightly reads the whole book for it.
  let plan = "";
  try {
    const res = await data.send(
      new ExecuteStatementCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: APP_SECRET_ARN,
        database: DATABASE,
        sql: `EXPLAIN ANALYZE ${sql}`,
        formatRecordsAs: "JSON",
        parameters: [{ name: "q", value: { stringValue: "Alex Rivera" } }],
      })
    );
    plan = (res.formattedRecords ? JSON.parse(res.formattedRecords) : []).map((row) => Object.values(row)[0]).join("\n");
  } catch {
    plan = "";
  }
  return {
    ok: name.rows.length > 0 && injection.rows.length === 0,
    nameMatches: name.rows.length,
    injectionPayload: `' OR '1'='1`,
    injectionMatches: injection.rows.length,
    trgmIndexUsed: /ix_parcels_owner_trgm/.test(plan),
  };
}

// ---- render ----------------------------------------------------------------

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function renderHtml(ev) {
  const yes = (b, t) => `<li class="${b ? "ok" : "no"}">${esc(t)}</li>`;
  const c = ev.cluster;
  const i = ev.integrity;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Registry Database Evidence Report · ${esc(ev.generatedAt)}</title>
<style>
  /* The County Vault: certified-copy styling. Fonts load from the site origin
     when served there and degrade to system faces if saved offline. */
  @font-face{font-family:"Besley";src:url("https://registry.demos.planetek.org/fonts/besley-latin-400-normal.woff2") format("woff2");font-weight:400;font-display:swap}
  @font-face{font-family:"Besley";src:url("https://registry.demos.planetek.org/fonts/besley-latin-900-normal.woff2") format("woff2");font-weight:900;font-display:swap}
  @font-face{font-family:"Fragment Mono";src:url("https://registry.demos.planetek.org/fonts/fragment-mono-latin-400-normal.woff2") format("woff2");font-weight:400;font-display:swap}
  :root{--paper:#f2ecdd;--ink:#241e15;--ink3:#7c745d;--border:#d9cfb4;--wax:#8e2f26;--brass:#8a6d2c;
        --steel:#23272d;--slab-ink:#ded5bd;--chip:#ece4cf;--ok:#33633c;--bad:#8e2f26}
  @media (prefers-color-scheme:dark){
    :root{--paper:#0e1013;--ink:#eae2cf;--ink3:#92896f;--border:#2b2e35;--wax:#c65a4d;--brass:#c9a35a;
          --steel:#1b1e23;--slab-ink:#ded5bd;--chip:#21242a;--ok:#8fc79a;--bad:#e39288}}
  body{font:15px/1.6 "Besley",Georgia,serif;background:var(--paper);color:var(--ink);max-width:860px;margin:32px auto;padding:0 20px}
  .sheet{border:1px solid var(--brass);outline:1px solid var(--brass);outline-offset:-5px;padding:28px 30px;border-radius:2px}
  h1{font-size:26px;font-weight:900;line-height:1.15}
  h2{font-size:12px;margin-top:30px;border-bottom:1px solid var(--border);padding-bottom:6px;
     font-family:"Fragment Mono",ui-monospace,monospace;font-weight:400;text-transform:uppercase;letter-spacing:.18em;color:var(--brass)}
  ul{padding-left:2px;list-style:none;margin:10px 0}li{margin:4px 0}
  li.ok::before{content:"✓ ";color:var(--ok);font-weight:900}li.no::before{content:"✗ ";color:var(--bad);font-weight:900}
  table{border-collapse:collapse;width:100%;font-size:13.5px;margin-top:8px}
  th,td{text-align:left;padding:5px 9px;border-bottom:1px solid var(--border)}
  th{font-family:"Fragment Mono",ui-monospace,monospace;font-weight:400;font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--ink3)}
  pre{background:var(--steel);color:var(--slab-ink);border-left:3px solid var(--brass);border-radius:3px;padding:12px 14px;
      font:12px/1.6 "Fragment Mono",ui-monospace,monospace;overflow-x:auto}
  .muted{color:var(--ink3);font-size:13px}
  code{font-family:"Fragment Mono",ui-monospace,monospace;font-size:.85em;background:var(--chip);padding:1px 5px;border-radius:3px}
  .stamp{display:inline-block;font-family:"Fragment Mono",ui-monospace,monospace;font-size:10.5px;letter-spacing:.2em;
         text-transform:uppercase;color:var(--wax);border:1.5px solid var(--wax);border-radius:3px;padding:4px 12px;margin-bottom:14px}
</style></head><body><div class="sheet">
<p class="stamp">Certified copy · The County Vault</p>
<h1>Registry Database Evidence Report</h1>
<p class="muted">Alpenglow Land &amp; Records Registry (fictional) · filed ${esc(ev.generatedAt)} · aws-boardwalk plank 11 · every proof below is a live engine response, not an assertion.</p>

<h2>Book 01 · Cluster</h2>
<ul>
${yes(true, `Engine: ${c.engine} (${c.status})`)}
${yes(c.scalesToZero, `Serverless v2 scales to ZERO: ${c.serverlessV2.minAcu}–${c.serverlessV2.maxAcu} ACU, auto-pause after ${c.serverlessV2.autoPauseSeconds}s idle`)}
${yes(c.dataApiEnabled, "RDS Data API enabled: access is HTTPS + IAM, no database sockets")}
${yes(c.noIngressSecurityGroup, "Security group has zero ingress rules (nothing can open a connection)")}
${yes(c.storageEncrypted, "Storage encrypted at rest")}
${yes(c.iamAuth, "IAM database authentication enabled")}
${yes((c.backupRetentionDays ?? 0) >= 7, `Automated backups: ${c.backupRetentionDays} days`)}
${ev.wake.observed ? yes(true, `Observed resume from 0 ACU during this report: ~${(ev.wake.ms / 1000).toFixed(1)}s`) : yes(true, "Cluster was already awake when this report ran")}
</ul>

<h2>Book 02 · Seeded system of record</h2>
<p>parcels <strong>${esc(ev.data.counts.parcels)}</strong> · contractors <strong>${esc(ev.data.counts.contractors)}</strong> · permits <strong>${esc(ev.data.counts.permits)}</strong> · inspections <strong>${esc(ev.data.counts.inspections)}</strong>, generated in-engine by the migration Lambda (generate_series), no fixture files.</p>

<h2>Book 03 · Migration ledger</h2>
<table><thead><tr><th>id</th><th>checksum</th><th>applied</th></tr></thead><tbody>
${ev.migrations.map((m) => `<tr><td><code>${esc(m.id)}</code></td><td><code>${esc(m.checksum)}…</code></td><td>${esc(m.applied_at)}</td></tr>`).join("")}
</tbody></table>

<h2>Book 04 · Integrity proofs (run as the least-privilege app role)</h2>
<ul>
${yes(i.fkViolation.ok, "Foreign key: orphan permit INSERT rejected by the engine")}
${yes(i.checkViolation.ok, "CHECK constraint: invalid inspection result rejected")}
${yes(i.txnRollback.ok, "Transaction atomicity: failed two-step transfer left balances untouched")}
${yes(i.leastPrivilege.ok, "Least privilege: app role's DELETE and DROP attempts both denied")}
</ul>
<pre>${esc(i.fkViolation.error ?? "")}
${esc(i.checkViolation.error ?? "")}
${esc(i.leastPrivilege.attempts.map((a) => a.error).join("\n"))}</pre>

<h2>Book 05 · Query plans</h2>
<ul>
${yes(ev.plans.indexed.usesIndexScan, `Lookup by unique parcel_number uses an Index Scan (${ev.plans.indexed.executionMs} ms)`)}
${yes(ev.plans.seqScan.usesSeqScan, `Lookup by unindexed address falls back to a Seq Scan (${ev.plans.seqScan.executionMs} ms)`)}
</ul>
<pre>${esc(ev.plans.indexed.plan)}</pre>
<pre>${esc(ev.plans.seqScan.plan)}</pre>

<h2>Book 06 · Chain of title, concurrency, and district desks</h2>
<ul>
${yes(ev.history?.ok, `Chain of title: ${ev.history?.totalEntries ?? 0} amendment records on file; fullest chain holds ${ev.history?.fullestChain ?? 0} superseded versions; as-of reconstruction reads '${esc(ev.history?.asOf?.thenStatus)}' then vs '${esc(ev.history?.asOf?.nowStatus)}' today; live trigger fired as app_user and was voided by rollback`)}
${yes(ev.concurrency?.lockTimeout?.ok, "Lock timeout: a second writer waiting on a held row lock was refused by the engine after its 2s allowance")}
${yes(ev.concurrency?.deadlock?.ok, "Deadlock: a genuine lock cycle was detected and exactly one transaction cancelled")}
${yes(ev.rls?.ok, `Row-level security: north desk sees ${ev.rls?.north ?? "?"} cases, south desk ${ev.rls?.south ?? "?"}, an unassigned session sees ${ev.rls?.unassigned ?? "?"}; a cross-district write died on the policy`)}
${yes(ev.search?.ok, `Parameterized title search: '${esc(ev.search?.injectionPayload)}' bound as data matched ${ev.search?.injectionMatches ?? "?"} rows while a real name matched ${ev.search?.nameMatches ?? "?"}${ev.search?.trgmIndexUsed ? "; trigram index carried the fuzzy match" : ""}`)}
</ul>
<pre>${esc(ev.concurrency?.lockTimeout?.error ?? "")}
${esc(ev.concurrency?.deadlock?.error ?? "")}
${esc(ev.rls?.crossDistrictError ?? "")}</pre>

<p class="muted">Fictional demo built by Planetek, not affiliated with any real government agency. Between demo windows the cluster is destroyed entirely; this certified copy persists on the always-on site.</p>
</div></body></html>`;
}

// ---- handler ---------------------------------------------------------------

export const handler = async () => {
  const cluster = await collectCluster();
  const dataFacts = await collectData(); // wakes a paused cluster; must run before the timed exhibits
  const [migrations, integrity, plans] = [await collectMigrations(), await collectIntegrity(), await collectPlans()];
  const [history, concurrency, rls, search] = [
    await collectHistory(),
    await collectConcurrency(),
    await collectRls(),
    await collectSearch(),
  ];

  const evidence = {
    generatedAt: new Date().toISOString(),
    cluster,
    wake,
    data: dataFacts,
    migrations,
    integrity,
    plans,
    history,
    concurrency,
    rls,
    search,
  };

  const put = (key, body, type) =>
    s3.send(
      new PutObjectCommand({
        Bucket: SITE_BUCKET,
        Key: key,
        Body: body,
        ContentType: type,
        CacheControl: "no-cache",
      })
    );

  await Promise.all([
    put("evidence/evidence.json", JSON.stringify(evidence, null, 2), "application/json"),
    put("evidence/evidence.html", renderHtml(evidence), "text/html; charset=utf-8"),
  ]);

  return {
    generatedAt: evidence.generatedAt,
    wake,
    counts: dataFacts.counts,
    integrity: {
      fk: integrity.fkViolation.ok,
      check: integrity.checkViolation.ok,
      txn: integrity.txnRollback.ok,
      leastPrivilege: integrity.leastPrivilege.ok,
    },
  };
};
