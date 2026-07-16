import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
} from '@aws-sdk/client-athena';

const athena = new AthenaClient({});

const DB = process.env.GLUE_DB!;
const WORKGROUP = process.env.WORKGROUP!;

export interface QueryStats {
  bytesScanned: number;
  engineMs: number;
  totalMs: number;
  /** $5/TB with Athena's 10 MB per-query minimum. */
  estCostUsd: number;
}

export interface QueryResult {
  columns: string[];
  rows: string[][];
  stats: QueryStats;
}

function costOf(bytes: number): number {
  const billed = Math.max(bytes, 10 * 1024 * 1024);
  return Number(((billed / 2 ** 40) * 5).toFixed(6));
}

/** Start a query in the workgroup and poll it to completion. */
export async function runQuery(sql: string, opts?: { pollMs?: number; deadlineMs?: number }): Promise<{ id: string; stats: QueryStats }> {
  const pollMs = opts?.pollMs ?? 400;
  const deadline = Date.now() + (opts?.deadlineMs ?? 24_000);

  const start = await athena.send(
    new StartQueryExecutionCommand({
      QueryString: sql,
      WorkGroup: WORKGROUP,
      QueryExecutionContext: { Database: DB },
    })
  );
  const id = start.QueryExecutionId!;

  for (;;) {
    const { QueryExecution: qe } = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
    const state = qe?.Status?.State;
    if (state === 'SUCCEEDED') {
      const s = qe?.Statistics;
      return {
        id,
        stats: {
          bytesScanned: Number(s?.DataScannedInBytes ?? 0),
          engineMs: Number(s?.EngineExecutionTimeInMillis ?? 0),
          totalMs: Number(s?.TotalExecutionTimeInMillis ?? 0),
          estCostUsd: costOf(Number(s?.DataScannedInBytes ?? 0)),
        },
      };
    }
    if (state === 'FAILED' || state === 'CANCELLED') {
      throw new Error(qe?.Status?.StateChangeReason ?? `query ${state}`);
    }
    if (Date.now() > deadline) throw new Error('query timed out — try again in a moment');
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Fetch up to maxRows result rows (the first result row is the header). */
export async function fetchRows(id: string, maxRows: number): Promise<{ columns: string[]; rows: string[][] }> {
  const res = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: id, MaxResults: maxRows + 1 }));
  const all = (res.ResultSet?.Rows ?? []).map((r) => (r.Data ?? []).map((d) => d.VarCharValue ?? ''));
  return { columns: all[0] ?? [], rows: all.slice(1) };
}

export async function runAndFetch(sql: string, maxRows: number, opts?: { pollMs?: number; deadlineMs?: number }): Promise<QueryResult> {
  const { id, stats } = await runQuery(sql, opts);
  const { columns, rows } = await fetchRows(id, maxRows);
  return { columns, rows, stats };
}
