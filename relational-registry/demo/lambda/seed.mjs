// Ordered, checksummed migration runner over the RDS Data API.
//
// Migrations are arrays of single statements (the Data API executes one
// statement per call), applied as the master user and recorded in
// registry.schema_migrations. Versioned migrations are skipped when their
// checksum already matches; the app-role migration is repeatable (it syncs
// the app_user password from Secrets Manager on every run); the seed
// migration regenerates all data in-engine with generate_series — no data
// files to ship, ~38k rows in a few seconds.
import {
  RDSDataClient,
  ExecuteStatementCommand,
} from "@aws-sdk/client-rds-data";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { createHash } from "node:crypto";

const { CLUSTER_ARN, MASTER_SECRET_ARN, APP_SECRET_ARN, DATABASE } = process.env;

const data = new RDSDataClient({});
const secrets = new SecretsManagerClient({});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isResuming = (err) =>
  /DatabaseResuming/i.test(err?.name ?? "") || /resum/i.test(err?.message ?? "");

// First statement after an auto-pause may need to wait out the resume.
async function exec(sql) {
  const deadline = Date.now() + 240_000;
  for (;;) {
    try {
      return await data.send(
        new ExecuteStatementCommand({
          resourceArn: CLUSTER_ARN,
          secretArn: MASTER_SECRET_ARN,
          database: DATABASE,
          sql,
          formatRecordsAs: "JSON",
        })
      );
    } catch (err) {
      if (isResuming(err) && Date.now() < deadline) {
        await sleep(5000);
        continue;
      }
      throw err;
    }
  }
}

const rows = (res) => (res.formattedRecords ? JSON.parse(res.formattedRecords) : []);

// ---- migrations ------------------------------------------------------------

const NAME_FIRST = `ARRAY['Alex','Jordan','Riley','Casey','Morgan','Avery','Quinn','Rowan','Sage','Emerson','Dakota','Reese']`;
// 36 surnames x 12 first names: enough name diversity that a full-name search
// fragment is selective and the trigram index genuinely beats a seq scan.
const NAME_LAST = `ARRAY['Rivera','Nakamura','Okafor','Svensson','Delgado','Whitfield','Amari','Castellanos','Byrd','Lindqvist','Okoye','Marsh',
  'Halvorsen','Petrov','Ibarra','Kowalski','Adeyemi','Tran','Moreau','Santiago','Vance','Oyelaran','Bergstrom','Kaur',
  'Mendoza','Achebe','Dvorak','Lucero','Haugen','Sato','Cortez','Ellingson','Mbeki','Rasmussen','Villanueva','Ochoa']`;

const migrations = (appPassword) => [
  {
    id: "001-schema",
    statements: [
      `CREATE SCHEMA IF NOT EXISTS registry`,
      `CREATE SCHEMA IF NOT EXISTS sandbox`,
      `CREATE TABLE IF NOT EXISTS registry.schema_migrations (
         id         text PRIMARY KEY,
         checksum   text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE TABLE IF NOT EXISTS registry.parcels (
         id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         parcel_number text NOT NULL UNIQUE,
         address       text NOT NULL,
         owner_name    text NOT NULL,
         zoning        text NOT NULL CHECK (zoning IN ('residential','commercial','mixed-use','agricultural','industrial')),
         acreage       numeric(7,3) NOT NULL CHECK (acreage > 0),
         created_at    timestamptz NOT NULL DEFAULT now()
       )`,
      `CREATE TABLE IF NOT EXISTS registry.contractors (
         id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         license_no text NOT NULL UNIQUE,
         name       text NOT NULL,
         trade      text NOT NULL CHECK (trade IN ('general','electrical','plumbing','mechanical','solar','roofing')),
         active     boolean NOT NULL DEFAULT true
       )`,
      `CREATE TABLE IF NOT EXISTS registry.permits (
         id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         permit_number text NOT NULL UNIQUE,
         parcel_id     bigint NOT NULL REFERENCES registry.parcels(id),
         contractor_id bigint REFERENCES registry.contractors(id),
         permit_type   text NOT NULL CHECK (permit_type IN ('building','electrical','plumbing','mechanical','demolition','solar')),
         status        text NOT NULL CHECK (status IN ('submitted','in_review','issued','denied','expired','closed')),
         valuation     numeric(12,2) NOT NULL CHECK (valuation >= 0),
         submitted_at  date NOT NULL,
         issued_at     date,
         CONSTRAINT issued_after_submitted CHECK (issued_at IS NULL OR issued_at >= submitted_at)
       )`,
      `CREATE TABLE IF NOT EXISTS registry.inspections (
         id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         permit_id       bigint NOT NULL REFERENCES registry.permits(id) ON DELETE CASCADE,
         inspection_type text NOT NULL CHECK (inspection_type IN ('footing','framing','electrical','plumbing','mechanical','final')),
         result          text NOT NULL CHECK (result IN ('pass','fail','partial')),
         inspected_at    date NOT NULL,
         notes           text
       )`,
      `CREATE TABLE IF NOT EXISTS sandbox.ledger (
         account text PRIMARY KEY,
         balance numeric(12,2) NOT NULL CHECK (balance >= 0)
       )`,
    ],
  },
  {
    id: "002-indexes-views",
    statements: [
      `CREATE INDEX IF NOT EXISTS ix_permits_parcel ON registry.permits (parcel_id)`,
      `CREATE INDEX IF NOT EXISTS ix_permits_status ON registry.permits (status)`,
      `CREATE INDEX IF NOT EXISTS ix_inspections_permit ON registry.inspections (permit_id)`,
      // address stays deliberately unindexed — the EXPLAIN exhibit compares the
      // unique parcel_number index scan against its sequential scan. owner_name
      // gains a trigram index in 005 for the title-search exhibit.
      `CREATE OR REPLACE VIEW registry.permit_throughput AS
         SELECT date_trunc('month', submitted_at)::date AS month,
                permit_type,
                count(*) AS submitted,
                count(*) FILTER (WHERE status IN ('issued','closed')) AS issued,
                round(avg(issued_at - submitted_at) FILTER (WHERE issued_at IS NOT NULL), 1) AS avg_days_to_issue
           FROM registry.permits
          GROUP BY 1, 2`,
      `CREATE OR REPLACE VIEW registry.contractor_scorecard AS
         SELECT c.license_no,
                c.name,
                c.trade,
                count(DISTINCT pe.id) AS permits,
                count(i.id) AS inspections,
                round(100.0 * count(i.id) FILTER (WHERE i.result = 'pass') / NULLIF(count(i.id), 0), 1) AS pass_rate_pct
           FROM registry.contractors c
           JOIN registry.permits pe ON pe.contractor_id = c.id
           LEFT JOIN registry.inspections i ON i.permit_id = pe.id
          GROUP BY c.id, c.license_no, c.name, c.trade`,
    ],
  },
  {
    // Repeatable: reruns every invocation so the app_user password always
    // matches the rdb-app-credentials secret (regenerated each demo cycle).
    id: "R-app-role",
    repeatable: true,
    statements: [
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
           CREATE ROLE app_user LOGIN;
         END IF;
       END $$`,
      `ALTER ROLE app_user WITH LOGIN PASSWORD '${appPassword}'`,
      `GRANT USAGE ON SCHEMA registry TO app_user`,
      `GRANT USAGE ON SCHEMA sandbox TO app_user`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA registry TO app_user`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA registry GRANT SELECT ON TABLES TO app_user`,
      `GRANT USAGE ON ALL SEQUENCES IN SCHEMA registry TO app_user`,
      // Only what the always-rolled-back integrity exhibits need:
      `GRANT INSERT ON registry.permits TO app_user`,
      `GRANT INSERT ON registry.inspections TO app_user`,
      `GRANT SELECT, UPDATE ON sandbox.ledger TO app_user`,
    ],
  },
  {
    id: "004-seed-data",
    statements: [
      `TRUNCATE registry.inspections, registry.permits, registry.contractors, registry.parcels RESTART IDENTITY CASCADE`,
      `DELETE FROM sandbox.ledger`,
      `INSERT INTO registry.parcels (parcel_number, address, owner_name, zoning, acreage)
       SELECT 'AP-' || lpad(g::text, 5, '0'),
              (50 + (g * 7) % 9900)::text || ' ' ||
                (ARRAY['Alpenglow Ave','Larkspur Ln','Timberline Rd','Juniper Ct','Ridgeway Dr','Moraine St','Cirque Loop','Basin View Way'])[1 + floor(random()*8)::int],
              (${NAME_FIRST})[1 + floor(random()*12)::int] || ' ' || (${NAME_LAST})[1 + floor(random()*36)::int],
              (ARRAY['residential','commercial','mixed-use','agricultural','industrial'])[1 + floor(random()*5)::int],
              round((0.05 + random() * 2.2)::numeric, 3)
         FROM generate_series(1, 20000) g`,
      `INSERT INTO registry.contractors (license_no, name, trade, active)
       SELECT 'CO-' || lpad(g::text, 4, '0'),
              (${NAME_LAST})[1 + floor(random()*12)::int] || ' ' ||
                (ARRAY['Builders','Electric','Plumbing Co','Mechanical','Solar Works','Contracting'])[1 + floor(random()*6)::int],
              (ARRAY['general','electrical','plumbing','mechanical','solar','roofing'])[1 + floor(random()*6)::int],
              random() > 0.06
         FROM generate_series(1, 150) g`,
      `INSERT INTO registry.permits (permit_number, parcel_id, contractor_id, permit_type, status, valuation, submitted_at, issued_at)
       SELECT 'BP-' || (2023 + (g % 4))::text || '-' || lpad(g::text, 5, '0'),
              pid, cid, ptype, st,
              round((2500 + r3 * 380000)::numeric, 2),
              sub,
              CASE WHEN st IN ('issued','closed','expired') THEN sub + (3 + floor(r4 * 55))::int END
         FROM (
           SELECT g,
                  1 + floor(random()*20000)::bigint AS pid,
                  CASE WHEN random() < 0.82 THEN 1 + floor(random()*150)::bigint END AS cid,
                  (ARRAY['building','electrical','plumbing','mechanical','demolition','solar'])[1 + floor(random()*6)::int] AS ptype,
                  CASE WHEN random() < 0.12 THEN 'submitted'
                       WHEN random() < 0.18 THEN 'in_review'
                       WHEN random() < 0.62 THEN 'issued'
                       WHEN random() < 0.20 THEN 'denied'
                       WHEN random() < 0.40 THEN 'expired'
                       ELSE 'closed' END AS st,
                  random() AS r3,
                  random() AS r4,
                  date '2023-01-02' + floor(random() * 1280)::int AS sub
             FROM generate_series(1, 6000) g
         ) t`,
      `INSERT INTO registry.inspections (permit_id, inspection_type, result, inspected_at)
       SELECT 1 + floor(random()*6000)::bigint,
              (ARRAY['footing','framing','electrical','plumbing','mechanical','final'])[1 + floor(random()*6)::int],
              CASE WHEN random() < 0.70 THEN 'pass' WHEN random() < 0.50 THEN 'fail' ELSE 'partial' END,
              date '2023-02-01' + floor(random() * 1250)::int
         FROM generate_series(1, 12000) g`,
      `INSERT INTO sandbox.ledger (account, balance) VALUES ('permit-escrow', 2500.00), ('general-fund', 10000.00)`,
    ],
  },
  {
    // Chain of title: every UPDATE on a permit files the superseded version
    // into permit_history via a SECURITY DEFINER trigger, so app_user can
    // amend (column-level UPDATE only) without any grant on the history book.
    id: "005-chain-of-title",
    statements: [
      `CREATE TABLE IF NOT EXISTS registry.permit_history (
         id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         permit_id     bigint NOT NULL REFERENCES registry.permits(id) ON DELETE CASCADE,
         status        text NOT NULL,
         valuation     numeric(12,2) NOT NULL,
         contractor_id bigint,
         amended_by    text NOT NULL,
         note          text,
         valid_from    timestamptz NOT NULL,
         valid_to      timestamptz NOT NULL,
         CONSTRAINT history_window CHECK (valid_to >= valid_from)
       )`,
      `CREATE INDEX IF NOT EXISTS ix_history_permit ON registry.permit_history (permit_id, valid_from)`,
      `ALTER TABLE registry.permits ADD COLUMN IF NOT EXISTS last_amended_at timestamptz NOT NULL DEFAULT now()`,
      `CREATE OR REPLACE FUNCTION registry.record_amendment() RETURNS trigger
       LANGUAGE plpgsql SECURITY DEFINER SET search_path = registry, pg_temp AS $$
       BEGIN
         INSERT INTO registry.permit_history
                (permit_id, status, valuation, contractor_id, amended_by, note, valid_from, valid_to)
         VALUES (OLD.id, OLD.status, OLD.valuation, OLD.contractor_id, session_user,
                 nullif(current_setting('registry.amendment_note', true), ''),
                 OLD.last_amended_at, clock_timestamp());
         -- session_user, not current_user: inside a SECURITY DEFINER function
         -- current_user is the definer (the master role), which would hide the
         -- actual clerk. session_user stays the login role that amended.
         NEW.last_amended_at := clock_timestamp();
         RETURN NEW;
       END $$`,
      `GRANT SELECT ON registry.permit_history TO app_user`,
      // Column-level grant: app_user may amend a permit's status/valuation but
      // can never touch its number, parcel, or dates. The live exhibit rolls
      // its amendment back anyway.
      `GRANT UPDATE (status, valuation) ON registry.permits TO app_user`,
      // Title search rides a trigram index on owner_name. The seq-scan lesson
      // in the EXPLAIN exhibit moves to address, which stays unindexed.
      `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
      `CREATE INDEX IF NOT EXISTS ix_parcels_owner_trgm ON registry.parcels USING gin (owner_name gin_trgm_ops)`,
    ],
  },
  {
    // Backfill amendment history for a slice of decided permits, then attach
    // the trigger LAST so the backfill's own UPDATEs never self-record. Only
    // permits older than 100 days get history, so no valid_to lands in the
    // future and "as of today" always resolves to the current row.
    id: "006-history-backfill",
    statements: [
      `DROP TRIGGER IF EXISTS trg_record_amendment ON registry.permits`,
      `TRUNCATE registry.permit_history RESTART IDENTITY`,
      `UPDATE registry.permits SET last_amended_at = submitted_at::timestamptz`,
      `INSERT INTO registry.permit_history (permit_id, status, valuation, contractor_id, amended_by, note, valid_from, valid_to)
       SELECT id, 'submitted', round(valuation * 0.82, 2), contractor_id, 'records_desk',
              'As first presented at the counter',
              submitted_at::timestamptz, submitted_at::timestamptz + interval '21 days'
         FROM registry.permits
        WHERE id % 7 = 3 AND status <> 'submitted' AND submitted_at < current_date - 100`,
      `INSERT INTO registry.permit_history (permit_id, status, valuation, contractor_id, amended_by, note, valid_from, valid_to)
       SELECT id, 'in_review', round(valuation * 0.82, 2), contractor_id, 'review_desk',
              'Under review by the plans examiner',
              submitted_at::timestamptz + interval '21 days', submitted_at::timestamptz + interval '52 days'
         FROM registry.permits
        WHERE id % 7 = 3 AND status IN ('issued','closed','denied','expired') AND submitted_at < current_date - 100`,
      `INSERT INTO registry.permit_history (permit_id, status, valuation, contractor_id, amended_by, note, valid_from, valid_to)
       SELECT id, 'issued', round(valuation * 0.82, 2), contractor_id, 'audit_desk',
              'Valuation corrected on audit',
              submitted_at::timestamptz + interval '52 days', submitted_at::timestamptz + interval '80 days'
         FROM registry.permits
        WHERE id % 7 = 3 AND id % 13 = 5 AND status IN ('closed','expired') AND submitted_at < current_date - 100`,
      `UPDATE registry.permits p
          SET last_amended_at = h.latest
         FROM (SELECT permit_id, max(valid_to) AS latest FROM registry.permit_history GROUP BY permit_id) h
        WHERE h.permit_id = p.id`,
      `CREATE TRIGGER trg_record_amendment BEFORE UPDATE ON registry.permits
       FOR EACH ROW EXECUTE FUNCTION registry.record_amendment()`,
    ],
  },
  {
    // Row-level security: two district desks over one table. app_user only
    // sees (and can only write) rows matching its per-transaction desk
    // assignment; with no assignment it sees nothing at all.
    id: "007-district-desks",
    statements: [
      `CREATE TABLE IF NOT EXISTS sandbox.case_files (
         id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         district      text NOT NULL CHECK (district IN ('north','south')),
         case_number   text NOT NULL UNIQUE,
         parcel_number text NOT NULL,
         subject       text NOT NULL,
         status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed'))
       )`,
      `TRUNCATE sandbox.case_files RESTART IDENTITY`,
      `INSERT INTO sandbox.case_files (district, case_number, parcel_number, subject, status) VALUES
         ('north', 'CF-2026-0104', 'AP-00311', 'Fence built over the setback line', 'open'),
         ('north', 'CF-2026-0117', 'AP-00892', 'Unpermitted deck addition', 'open'),
         ('north', 'CF-2026-0121', 'AP-01458', 'Short-term rental without a license', 'closed'),
         ('north', 'CF-2026-0135', 'AP-00077', 'Drainage altered onto a neighboring lot', 'open'),
         ('north', 'CF-2026-0142', 'AP-01633', 'Sign exceeds the permitted square footage', 'open'),
         ('south', 'CF-2026-0203', 'AP-01120', 'Retaining wall without an engineering stamp', 'open'),
         ('south', 'CF-2026-0219', 'AP-00540', 'Work continuing past permit expiration', 'open'),
         ('south', 'CF-2026-0228', 'AP-01986', 'Occupancy before the final inspection', 'closed')`,
      `ALTER TABLE sandbox.case_files ENABLE ROW LEVEL SECURITY`,
      `DROP POLICY IF EXISTS district_desk ON sandbox.case_files`,
      `CREATE POLICY district_desk ON sandbox.case_files
         FOR ALL TO app_user
         USING (district = current_setting('app.clerk_district', true))
         WITH CHECK (district = current_setting('app.clerk_district', true))`,
      `GRANT SELECT, UPDATE ON sandbox.case_files TO app_user`,
    ],
  },
  {
    // Repeatable, always last: fresh planner statistics immediately after a
    // bulk reseed. Without this the evidence report can run before autovacuum
    // ANALYZEs the new rows, and the planner seq-scans queries the trigram
    // index should carry (observed live 2026-07-31).
    id: "R-analyze",
    repeatable: true,
    statements: [
      `ANALYZE registry.parcels`,
      `ANALYZE registry.contractors`,
      `ANALYZE registry.permits`,
      `ANALYZE registry.inspections`,
      `ANALYZE registry.permit_history`,
      `ANALYZE sandbox.case_files`,
    ],
  },
];

const checksum = (statements) => createHash("sha256").update(statements.join("\n")).digest("hex");

export const handler = async (event = {}) => {
  const force = event.force === true;

  const appSecret = JSON.parse(
    (await secrets.send(new GetSecretValueCommand({ SecretId: APP_SECRET_ARN }))).SecretString
  );

  const plan = migrations(appSecret.password);

  // Bootstrap enough of 001 to be able to read the ledger at all.
  await exec(plan[0].statements[0]);
  await exec(plan[0].statements[2]);

  const appliedRows = rows(await exec(`SELECT id, checksum FROM registry.schema_migrations`));
  const prior = new Map(appliedRows.map((r) => [r.id, r.checksum]));

  const applied = [];
  const skipped = [];

  for (const m of plan) {
    const sum = checksum(m.statements);
    if (!m.repeatable && !force && prior.get(m.id) === sum) {
      skipped.push(m.id);
      continue;
    }
    for (const s of m.statements) await exec(s);
    await exec(
      `INSERT INTO registry.schema_migrations (id, checksum, applied_at)
       VALUES ('${m.id}', '${sum}', now())
       ON CONFLICT (id) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`
    );
    applied.push(m.id);
  }

  const counts = rows(
    await exec(
      `SELECT (SELECT count(*) FROM registry.parcels)     AS parcels,
              (SELECT count(*) FROM registry.contractors) AS contractors,
              (SELECT count(*) FROM registry.permits)     AS permits,
              (SELECT count(*) FROM registry.inspections) AS inspections`
    )
  )[0];

  return { applied, skipped, counts };
};
