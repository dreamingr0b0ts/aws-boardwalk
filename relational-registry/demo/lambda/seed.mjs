// Ordered, checksummed migration runner over the RDS Data API.
//
// Migrations are arrays of single statements (the Data API executes one
// statement per call), applied as the master user and recorded in
// registry.schema_migrations. Versioned migrations are skipped when their
// checksum already matches; the app-role migration is repeatable (it syncs
// the app_user password from Secrets Manager on every run); the seed
// migration regenerates all data in-engine with generate_series — no data
// files to ship, ~20k rows in a few seconds.
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
const NAME_LAST = `ARRAY['Rivera','Nakamura','Okafor','Svensson','Delgado','Whitfield','Amari','Castellanos','Byrd','Lindqvist','Okoye','Marsh']`;

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
      // owner_name stays deliberately unindexed — the EXPLAIN exhibit compares
      // the unique parcel_number index scan against this sequential scan.
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
              (${NAME_FIRST})[1 + floor(random()*12)::int] || ' ' || (${NAME_LAST})[1 + floor(random()*12)::int],
              (ARRAY['residential','commercial','mixed-use','agricultural','industrial'])[1 + floor(random()*5)::int],
              round((0.05 + random() * 2.2)::numeric, 3)
         FROM generate_series(1, 2000) g`,
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
                  1 + floor(random()*2000)::bigint AS pid,
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
