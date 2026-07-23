import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { PermitType, StatsResponse } from '../types';
import { ErrorNote, KpiTile, Spinner, WindowPlate } from '../components/Ui';
import { MonthlyTrend, StatusBreakdown, TypeBar } from '../components/Charts';

export default function Stats() {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [types, setTypes] = useState<PermitType[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    void api<StatsResponse>('/public/stats').then(setStats).catch((e: Error) => setError(e.message));
    void api<{ types: PermitType[] }>('/public/permit-types').then((r) => setTypes(r.types)).catch(() => undefined);
  }, []);

  if (error) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-10">
        <ErrorNote message={error} />
      </div>
    );
  }
  if (!stats?.current) return <Spinner label="Loading office data…" />;

  const received12 = stats.monthly.reduce((s, m) => s + m.received, 0);
  const approved12 = stats.monthly.reduce((s, m) => s + m.approved, 0);
  const approvalRate = received12 ? Math.round((approved12 / received12) * 100) : 0;
  const latest = stats.monthly.at(-1);
  const open = stats.current.counts.submitted + stats.current.counts.under_review;
  const typeNames = Object.fromEntries(types.map((t) => [t.slug, t.name]));

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <WindowPlate n="02" label="Records and performance" />
      <h1 className="mt-3 font-display text-2xl font-bold text-pine-950 dark:text-pine-100">Permit office performance</h1>
      <p className="mt-1 max-w-2xl text-sm text-stone-500 dark:text-stone-400">
        Published live from the permit system, the same numbers staff see. Transparency is policy in Alpenglow.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Applications, 12 months" value={received12.toLocaleString()} sub="all permit types" />
        <KpiTile label="Approval rate" value={`${approvalRate}%`} sub="of received, trailing 12 months" />
        <KpiTile label="Avg processing time" value={`${latest?.avgProcessingDays ?? '—'} days`} sub="most recent month" />
        <KpiTile label="Open right now" value={open.toLocaleString()} sub="submitted or under review" />
      </div>

      <div className="mt-6 grid gap-6">
        <MonthlyTrend monthly={stats.monthly} />
        <div className="grid gap-6 lg:grid-cols-2">
          <TypeBar monthly={stats.monthly} typeNames={typeNames} />
          <StatusBreakdown current={stats.current} />
        </div>
      </div>

      <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.08em] text-stone-400">
        Live from DynamoDB via the public API · reseeds nightly with the demo cycle
      </p>
    </div>
  );
}
