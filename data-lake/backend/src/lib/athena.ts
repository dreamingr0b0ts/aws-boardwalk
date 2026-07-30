import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  GetQueryRuntimeStatisticsCommand,
  type QueryStage,
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
  runtime?: RuntimeStats;
}

/** One node of the engine's distributed execution, flattened for display. */
export interface RuntimeStage {
  stage: number;
  state: string;
  inputRows: number;
  inputBytes: number;
  outputRows: number;
  outputBytes: number;
  ms: number;
}

export interface RuntimeStats {
  stages: RuntimeStage[];
  timeline: { queueMs: number; planningMs: number; engineMs: number; totalMs: number };
}

function costOf(bytes: number): number {
  const billed = Math.max(bytes, 10 * 1024 * 1024);
  return Number(((billed / 2 ** 40) * 5).toFixed(6));
}

export interface RunOpts {
  pollMs?: number;
  deadlineMs?: number;
  /** Bound to `?` placeholders in order. Values are parsed by Athena as single
      expressions in the placeholder position — string literals must arrive
      single-quoted with embedded quotes doubled (see quoteParam). */
  params?: string[];
}

/** Start a query in the workgroup and poll it to completion. */
export async function runQuery(sql: string, opts?: RunOpts): Promise<{ id: string; stats: QueryStats }> {
  const pollMs = opts?.pollMs ?? 400;
  const deadline = Date.now() + (opts?.deadlineMs ?? 24_000);

  const start = await athena.send(
    new StartQueryExecutionCommand({
      QueryString: sql,
      WorkGroup: WORKGROUP,
      QueryExecutionContext: { Database: DB },
      ...(opts?.params ? { ExecutionParameters: opts.params } : {}),
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

/** Quote a value as an Athena varchar literal for an execution parameter. */
export function quoteParam(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Fetch up to maxRows result rows (the first result row is the header). */
export async function fetchRows(id: string, maxRows: number): Promise<{ columns: string[]; rows: string[][] }> {
  const res = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: id, MaxResults: maxRows + 1 }));
  const all = (res.ResultSet?.Rows ?? []).map((r) => (r.Data ?? []).map((d) => d.VarCharValue ?? ''));
  return { columns: all[0] ?? [], rows: all.slice(1) };
}

/** The engine's own account of how it ran the query: the distributed stage
    tree (flattened source-first) plus the queue/plan/execute timeline. Stats
    can lag completion by a moment; returns undefined rather than failing the
    response over a display extra. */
export async function getRuntimeStats(id: string): Promise<RuntimeStats | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await athena.send(new GetQueryRuntimeStatisticsCommand({ QueryExecutionId: id }));
      const s = res.QueryRuntimeStatistics;
      if (!s?.OutputStage) throw new Error('stats not ready');
      const stages: RuntimeStage[] = [];
      const walk = (st: QueryStage) => {
        for (const sub of st.SubStages ?? []) walk(sub);
        stages.push({
          stage: Number(st.StageId ?? stages.length),
          state: st.State ?? '',
          inputRows: Number(st.InputRows ?? 0),
          inputBytes: Number(st.InputBytes ?? 0),
          outputRows: Number(st.OutputRows ?? 0),
          outputBytes: Number(st.OutputBytes ?? 0),
          ms: Number(st.ExecutionTime ?? 0),
        });
      };
      walk(s.OutputStage);
      return {
        stages,
        timeline: {
          queueMs: Number(s.Timeline?.QueryQueueTimeInMillis ?? 0),
          planningMs: Number(s.Timeline?.QueryPlanningTimeInMillis ?? 0),
          engineMs: Number(s.Timeline?.EngineExecutionTimeInMillis ?? 0),
          totalMs: Number(s.Timeline?.TotalExecutionTimeInMillis ?? 0),
        },
      };
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return undefined;
}

export async function runAndFetch(sql: string, maxRows: number, opts?: RunOpts & { withRuntime?: boolean }): Promise<QueryResult> {
  const { id, stats } = await runQuery(sql, opts);
  const [{ columns, rows }, runtime] = await Promise.all([
    fetchRows(id, maxRows),
    opts?.withRuntime ? getRuntimeStats(id) : Promise.resolve(undefined),
  ]);
  return { columns, rows, stats, ...(runtime ? { runtime } : {}) };
}
