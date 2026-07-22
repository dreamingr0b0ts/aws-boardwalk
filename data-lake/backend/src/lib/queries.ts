// Every SQL statement in the plank lives here: the ETL's CTAS, the aggregates
// it precomputes for the dashboard, and the canned catalog visitors can run
// live. Visitors can ONLY run catalog entries by id — arbitrary SQL never
// crosses the API.

const DB = process.env.GLUE_DB!;
const RAW = `${DB}.${process.env.RAW_TABLE!}`;
const CURATED = `${DB}.${process.env.CURATED_TABLE!}`;

export const dropCurated = `DROP TABLE IF EXISTS ${CURATED}`;

// The whole "curated zone" in one statement: parse + rename (including the
// source's real 'jurisdictonofformation' typo), derive the partition key, and
// write partitioned Snappy Parquet. Partitioning by decade keeps the CTAS
// under Athena's 100-partitions-per-query limit (the data spans the 1860s to
// today ≈ 18 decades).
export function ctas(lakeBucket: string, curatedPrefix: string): string {
  return `CREATE TABLE ${CURATED}
WITH (
  format = 'PARQUET',
  write_compression = 'SNAPPY',
  external_location = 's3://${lakeBucket}/${curatedPrefix}/',
  partitioned_by = ARRAY['decade']
) AS
WITH src AS (
  SELECT
    entityid,
    entityname,
    upper(trim(principalcity))          AS city,
    upper(trim(principalstate))         AS state,
    substr(trim(principalzipcode), 1, 5) AS zip,
    entitystatus,
    entitytype,
    upper(trim(jurisdictonofformation)) AS jurisdiction,
    agentorganizationname,
    try(cast(substr(entityformdate, 1, 10) AS date)) AS form_date
  FROM ${RAW}
)
SELECT
  entityid              AS entity_id,
  entityname            AS entity_name,
  city,
  state,
  zip,
  entitystatus          AS status,
  entitytype            AS entity_type,
  jurisdiction,
  agentorganizationname AS agent_organization,
  form_date,
  year(form_date)       AS form_year,
  CASE
    WHEN form_date IS NULL THEN 'unknown'
    ELSE cast(year(form_date) / 10 * 10 AS varchar) || 's'
  END AS decade
FROM src`;
}

const CUR_YEAR = new Date().getUTCFullYear();

// Precomputed once per ETL run and served as static JSON — rendering the
// dashboard costs zero Athena.
export const aggregates: Record<string, string> = {
  formations_by_year: `SELECT form_year, count(*) AS n
FROM ${CURATED}
WHERE form_year BETWEEN 1990 AND ${CUR_YEAR}
GROUP BY form_year ORDER BY form_year`,

  entity_types: `SELECT entity_type, count(*) AS n
FROM ${CURATED}
GROUP BY entity_type ORDER BY n DESC LIMIT 8`,

  status_breakdown: `SELECT status, count(*) AS n
FROM ${CURATED}
GROUP BY status ORDER BY n DESC LIMIT 8`,

  top_cities: `SELECT city, count(*) AS n
FROM ${CURATED}
WHERE status = 'Good Standing' AND state = 'CO' AND city IS NOT NULL AND city <> ''
GROUP BY city ORDER BY n DESC LIMIT 12`,

  cohort_survival: `SELECT form_year,
  count(*) AS formed,
  sum(CASE WHEN status = 'Good Standing' THEN 1 ELSE 0 END) AS surviving
FROM ${CURATED}
WHERE form_year BETWEEN 1995 AND ${CUR_YEAR - 1}
GROUP BY form_year ORDER BY form_year`,
};

// count(*) over Parquet is answered from row-group metadata — it scans zero
// bytes, which the manifest calls out.
export const countRows = `SELECT count(*) AS n FROM ${CURATED}`;

export interface CatalogEntry {
  id: string;
  title: string;
  story: string;
  zone: 'raw' | 'curated';
  sql: string;
}

export const catalog: CatalogEntry[] = [
  {
    id: 'formations-recent',
    title: 'Formations by year since 2015',
    story:
      'The WHERE clause names the partition key, so Athena prunes to the 2010s/2020s Parquet folders and never touches the other sixteen decades. Watch the bytes-scanned number.',
    zone: 'curated',
    sql: `SELECT form_year, count(*) AS formations
FROM ${CURATED}
WHERE decade IN ('2010s', '2020s') AND form_year >= 2015
GROUP BY form_year ORDER BY form_year`,
  },
  {
    id: 'llc-share',
    title: 'The rise of the LLC',
    story: 'Share of each year’s new entities formed as LLCs (domestic + foreign) since 2000.',
    zone: 'curated',
    sql: `SELECT form_year,
  count(*) AS formed,
  round(100.0 * sum(CASE WHEN entity_type IN ('DLLC', 'FLLC') THEN 1 ELSE 0 END) / count(*), 1) AS llc_pct
FROM ${CURATED}
WHERE decade IN ('2000s', '2010s', '2020s')
GROUP BY form_year ORDER BY form_year`,
  },
  {
    id: 'top-cities-active',
    title: 'Where the active businesses are',
    story: 'Colorado cities ranked by entities currently in Good Standing.',
    zone: 'curated',
    sql: `SELECT city, count(*) AS in_good_standing
FROM ${CURATED}
WHERE status = 'Good Standing' AND state = 'CO' AND city <> ''
GROUP BY city ORDER BY in_good_standing DESC LIMIT 10`,
  },
  {
    id: 'out-of-state',
    title: 'Out-of-state registrations this decade',
    story: 'Where 2020s foreign (non-Colorado) entities were originally formed.',
    zone: 'curated',
    sql: `SELECT jurisdiction, count(*) AS registrations
FROM ${CURATED}
WHERE decade = '2020s' AND jurisdiction NOT IN ('CO', '')
GROUP BY jurisdiction ORDER BY registrations DESC LIMIT 10`,
  },
  {
    id: 'oldest-survivors',
    title: 'Oldest businesses still standing',
    story: 'The longest-lived registrations still in Good Standing; some predate Colorado statehood (1876).',
    zone: 'curated',
    sql: `SELECT entity_name, form_date, entity_type, city
FROM ${CURATED}
WHERE status = 'Good Standing' AND form_date IS NOT NULL
ORDER BY form_date ASC LIMIT 10`,
  },
  {
    id: 'zone-curated',
    title: 'Status counts, curated zone',
    story: 'One half of the raw-vs-curated race: the same aggregation over partitioned Snappy Parquet. Columnar layout means Athena reads only the one column it needs.',
    zone: 'curated',
    sql: `SELECT status, count(*) AS entities
FROM ${CURATED}
GROUP BY status ORDER BY entities DESC`,
  },
  {
    id: 'zone-raw',
    title: 'Status counts, raw zone',
    story: 'The other half of the race: the identical aggregation over the raw gzipped JSON. Row-oriented text means Athena must decompress and read every byte of every record.',
    zone: 'raw',
    sql: `SELECT entitystatus AS status, count(*) AS entities
FROM ${RAW}
GROUP BY entitystatus ORDER BY entities DESC`,
  },
];

export const catalogById = new Map(catalog.map((q) => [q.id, q]));
