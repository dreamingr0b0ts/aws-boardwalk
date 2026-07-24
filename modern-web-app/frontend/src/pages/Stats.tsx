import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useLang } from '../lib/i18n';
import type { AppStatus, InspectionState, PermitType, StatsResponse } from '../types';
import { ErrorNote, KpiTile, Spinner, StatusChip, WindowPlate, fmtDate } from '../components/Ui';
import { MonthlyTrend, StatusBreakdown, TypeBar } from '../components/Charts';

interface RegisterLine {
  id: string;
  typeName: string;
  category: string;
  address: string;
  status: AppStatus;
  decidedAt: string | null;
  inspection: InspectionState | null;
}

function downloadCsv(lines: RegisterLine[]) {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = [
    ['number', 'type', 'category', 'address', 'status', 'decided', 'inspection'],
    ...lines.map((l) => [l.id, l.typeName, l.category, l.address, l.status, l.decidedAt ?? '', l.inspection ?? '']),
  ];
  const blob = new Blob([rows.map((r) => r.map(esc).join(',')).join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'alpenglow-permit-register.csv';
  a.click();
  URL.revokeObjectURL(url);
}

export default function Stats() {
  const { t } = useLang();
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [types, setTypes] = useState<PermitType[]>([]);
  const [lines, setLines] = useState<RegisterLine[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void api<StatsResponse>('/public/stats').then(setStats).catch((e: Error) => setError(e.message));
    void api<{ types: PermitType[] }>('/public/permit-types').then((r) => setTypes(r.types)).catch(() => undefined);
    void api<{ lines: RegisterLine[] }>('/public/register').then((r) => setLines(r.lines)).catch(() => undefined);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return lines;
    return lines.filter((l) => `${l.id} ${l.typeName} ${l.address}`.toLowerCase().includes(q));
  }, [lines, query]);

  if (error) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-10">
        <ErrorNote message={error} />
      </div>
    );
  }
  if (!stats?.current) return <Spinner label={t('common.loading')} />;

  const received12 = stats.monthly.reduce((s, m) => s + m.received, 0);
  const approved12 = stats.monthly.reduce((s, m) => s + m.approved, 0);
  const approvalRate = received12 ? Math.round((approved12 / received12) * 100) : 0;
  const latest = stats.monthly.at(-1);
  const open = stats.current.counts.submitted + stats.current.counts.under_review;
  const typeNames = Object.fromEntries(types.map((t) => [t.slug, t.name]));

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <WindowPlate n="02" label={t('stats.window')} />
      <h1 className="mt-3 font-display text-2xl font-bold text-pine-950 dark:text-pine-100">{t('stats.h1')}</h1>
      <p className="mt-1 max-w-2xl text-sm text-stone-500 dark:text-stone-400">
        {t('stats.sub')}
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label={t('stats.kpiApps')} value={received12.toLocaleString()} sub={t('stats.kpiAppsSub')} />
        <KpiTile label={t('stats.kpiRate')} value={`${approvalRate}%`} sub={t('stats.kpiRateSub')} />
        <KpiTile label={t('stats.kpiAvg')} value={`${latest?.avgProcessingDays ?? '—'} ${t('stats.days')}`} sub={t('stats.kpiAvgSub')} />
        <KpiTile label={t('stats.kpiOpen')} value={open.toLocaleString()} sub={t('stats.kpiOpenSub')} />
      </div>

      <div className="mt-6 grid gap-6">
        <MonthlyTrend monthly={stats.monthly} />
        <div className="grid gap-6 lg:grid-cols-2">
          <TypeBar monthly={stats.monthly} typeNames={typeNames} />
          <StatusBreakdown current={stats.current} />
        </div>
      </div>

      {/* The register of decisions: browse, filter, verify, take the records */}
      <div className="mt-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="font-display text-xl font-bold text-pine-950 dark:text-pine-100">{t('register.title')}</h2>
            <p className="mt-1 max-w-xl text-sm text-stone-500 dark:text-stone-400">{t('register.sub')}</p>
          </div>
          <button
            onClick={() => downloadCsv(filtered)}
            disabled={filtered.length === 0}
            className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-700 hover:border-pine-400 hover:text-pine-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-300 dark:hover:border-pine-400 dark:hover:text-pine-200"
          >
            {t('register.csv')}
          </button>
        </div>

        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('register.search')}
          aria-label={t('register.search')}
          className="mt-4 w-full max-w-md rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 placeholder:text-stone-400 focus:border-pine-500 focus:outline-none focus:ring-2 focus:ring-pine-100 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:placeholder:text-stone-500 dark:focus:border-pine-400 dark:focus:ring-pine-900"
        />

        <div className="mt-4 overflow-x-auto rounded-xl border border-stone-200 bg-white shadow-sm dark:border-stone-800 dark:bg-stone-900">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 dark:border-stone-700 dark:bg-stone-950/60 text-left font-mono text-[10.5px] font-medium uppercase tracking-[0.12em] text-stone-500 dark:text-stone-400">
                <th className="px-4 py-3">{t('register.number')}</th>
                <th className="px-4 py-3">{t('register.type')}</th>
                <th className="px-4 py-3">{t('register.address')}</th>
                <th className="px-4 py-3">{t('register.decided')}</th>
                <th className="px-4 py-3">{t('register.status')}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100 dark:divide-stone-800">
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-stone-500 dark:text-stone-400">
                    {t('register.empty')}
                  </td>
                </tr>
              )}
              {filtered.slice(0, 50).map((l) => (
                <tr key={l.id} className="hover:bg-pine-50/60 dark:hover:bg-pine-900/20">
                  <td className="px-4 py-3 font-mono text-xs text-stone-500 dark:text-stone-400">{l.id}</td>
                  <td className="px-4 py-3 font-semibold text-stone-700 dark:text-stone-300">{l.typeName}</td>
                  <td className="px-4 py-3 text-stone-600 dark:text-stone-400">{l.address}</td>
                  <td className="px-4 py-3 font-mono text-xs text-stone-500 dark:text-stone-400">
                    {l.decidedAt ? fmtDate(l.decidedAt) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <StatusChip status={l.status} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      to={`/verify/${l.id}`}
                      className="rounded-md px-3 py-1 text-sm font-semibold text-pine-700 hover:bg-pine-50 dark:text-pine-300 dark:hover:bg-pine-900/40"
                    >
                      {t('register.verify')}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.08em] text-stone-500 dark:text-stone-400">
        {t('stats.live')}
      </p>
    </div>
  );
}
