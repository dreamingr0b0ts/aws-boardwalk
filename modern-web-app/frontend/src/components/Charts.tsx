import type { ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { AppStatus, CurrentStats, MonthStats } from '../types';
import { STATUS_LABEL } from '../types';
import { Card } from './Ui';
import { useTheme } from '../lib/theme';

// ---------------------------------------------------------------------------
// Chart kit. Mark palettes validated with the dataviz six-check validator on
// BOTH surfaces (light #fcfcfb and dark) — the same hues pass everywhere, so
// marks never change color between themes; only the chrome (grid, ticks,
// surface rings, tooltip) follows the surface:
//   series:  received #0d9488 · approved #e4532f
//   status:  submitted #0284c7 · under review #d97706 ·
//            approved #059669 · denied #e11d48
// Marks follow the spec: 2px lines, ≥8px ringed markers, ≤24px bars with 4px
// rounded data-ends, hairline solid gridlines, text in text tokens only.
// ---------------------------------------------------------------------------

export const SERIES = { received: '#0d9488', approved: '#e4532f' } as const;
export const STATUS_COLOR: Record<AppStatus, string> = {
  submitted: '#0284c7',
  under_review: '#d97706',
  approved: '#059669',
  denied: '#e11d48',
};

/** Surface-dependent chart chrome (never carries data identity). Hexes track
    the spruce-tinted stone scale in index.css — card surfaces are stone-900
    dark / white light, so chrome sits one step off those. */
function useChrome() {
  const { dark } = useTheme();
  return {
    grid: dark ? '#26332e' : '#e9eeeb', // one step off the card surface, solid hairline
    tick: { fontSize: 12, fill: dark ? '#9aa69f' : '#707d75' },
    axisLabel: dark ? '#dfe5e1' : '#59665e',
    ring: dark ? '#182420' : '#ffffff', // 2px surface ring on markers
    cursor: dark ? '#59665e' : '#c6cfc9',
    cursorFill: dark ? '#26332e' : '#f0f4f1',
  };
}

export function ChartCard({
  title,
  subtitle,
  legend,
  children,
}: {
  title: string;
  subtitle?: string;
  legend?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-bold text-pine-950 dark:text-pine-100">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">{subtitle}</p>}
        </div>
        {legend}
      </div>
      <div className="mt-4">{children}</div>
    </Card>
  );
}

export function LegendChips({ items }: { items: { label: string; color: string; value?: string }[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5 text-xs text-stone-600 dark:text-stone-300">
          <span className="size-2.5 rounded-full" style={{ backgroundColor: item.color }} aria-hidden />
          <span className="font-semibold">{item.label}</span>
          {item.value && <span className="text-stone-400 dark:text-stone-500">{item.value}</span>}
        </li>
      ))}
    </ul>
  );
}

function ChartTooltip({
  active,
  label,
  payload,
}: {
  active?: boolean;
  label?: string;
  payload?: { name?: string; value?: number | string; color?: string }[];
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-stone-700 dark:bg-stone-900">
      <p className="font-bold text-stone-700 dark:text-stone-200">{label}</p>
      <ul className="mt-1 space-y-0.5">
        {payload.map((row) => (
          <li key={row.name} className="flex items-center gap-1.5 text-stone-600 dark:text-stone-300">
            <span className="size-2 rounded-full" style={{ backgroundColor: row.color }} aria-hidden />
            {row.name}: <span className="font-semibold text-stone-800 dark:text-stone-100">{row.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function monthShort(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1, 1)).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
}

/** End-of-line marker: filled series dot with a 2px surface ring, last point only. */
function endDot(seriesColor: string, ring: string) {
  return function EndDot(props: { cx?: number; cy?: number; index?: number; dataLength: number }) {
    const { cx, cy, index, dataLength } = props;
    if (index !== dataLength - 1 || cx === undefined || cy === undefined) return <g />;
    return <circle cx={cx} cy={cy} r={4.5} fill={seriesColor} stroke={ring} strokeWidth={2} />;
  };
}

export function MonthlyTrend({ monthly }: { monthly: MonthStats[] }) {
  const ui = useChrome();
  const data = monthly.map((m) => ({ ...m, label: monthShort(m.month) }));
  return (
    <ChartCard
      title="Applications by month"
      subtitle="Trailing 12 months"
      legend={
        <LegendChips
          items={[
            { label: 'Received', color: SERIES.received },
            { label: 'Approved', color: SERIES.approved },
          ]}
        />
      }
    >
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
          <CartesianGrid vertical={false} stroke={ui.grid} strokeWidth={1} />
          <XAxis dataKey="label" tick={ui.tick} tickLine={false} axisLine={{ stroke: ui.grid }} />
          <YAxis tick={ui.tick} tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: ui.cursor, strokeWidth: 1 }} />
          <Line
            name="Received"
            dataKey="received"
            stroke={SERIES.received}
            strokeWidth={2}
            strokeLinecap="round"
            dot={endDot(SERIES.received, ui.ring) as never}
            activeDot={{ r: 5, stroke: ui.ring, strokeWidth: 2 }}
            isAnimationActive={false}
            {...{ dataLength: data.length }}
          />
          <Line
            name="Approved"
            dataKey="approved"
            stroke={SERIES.approved}
            strokeWidth={2}
            strokeLinecap="round"
            dot={endDot(SERIES.approved, ui.ring) as never}
            activeDot={{ r: 5, stroke: ui.ring, strokeWidth: 2 }}
            isAnimationActive={false}
            {...{ dataLength: data.length }}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function TypeBar({
  monthly,
  typeNames,
}: {
  monthly: MonthStats[];
  typeNames: Record<string, string>;
}) {
  const ui = useChrome();
  const totals = new Map<string, number>();
  for (const m of monthly) {
    for (const [slug, n] of Object.entries(m.byType ?? {})) {
      totals.set(slug, (totals.get(slug) ?? 0) + n);
    }
  }
  const data = [...totals.entries()]
    .map(([slug, count]) => ({ name: typeNames[slug] ?? slug, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  return (
    <ChartCard title="Volume by permit type" subtitle="Trailing 12 months · single measure, one hue">
      <ResponsiveContainer width="100%" height={data.length * 34 + 16}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 40, bottom: 0, left: 8 }}>
          <XAxis type="number" hide />
          <YAxis
            type="category"
            dataKey="name"
            width={190}
            tick={{ ...ui.tick, fill: ui.axisLabel }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: ui.cursorFill }} />
          <Bar name="Applications" dataKey="count" fill={SERIES.received} barSize={18} radius={[0, 4, 4, 0]} isAnimationActive={false}>
            <LabelList dataKey="count" position="right" style={{ fill: ui.axisLabel, fontSize: 12, fontWeight: 600 }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/**
 * Part-to-whole as a single horizontal stacked bar (per the form table), with
 * 2px surface gaps between segments and a full legend carrying the counts —
 * every value is directly visible, so no hover layer is needed.
 */
export function StatusBreakdown({ current }: { current: CurrentStats }) {
  const order: AppStatus[] = ['submitted', 'under_review', 'approved', 'denied'];
  const total = order.reduce((sum, s) => sum + (current.counts[s] ?? 0), 0);

  return (
    <ChartCard title="Applications in the system" subtitle={`${total} total, by current status`}>
      <div className="flex h-6 gap-0.5 overflow-hidden rounded-md" role="img" aria-label="Status breakdown bar">
        {order.map((s) => {
          const n = current.counts[s] ?? 0;
          if (n === 0) return null;
          return (
            <div
              key={s}
              style={{ width: `${(n / total) * 100}%`, backgroundColor: STATUS_COLOR[s] }}
              title={`${STATUS_LABEL[s]}: ${n}`}
            />
          );
        })}
      </div>
      <div className="mt-3">
        <LegendChips
          items={order.map((s) => ({
            label: STATUS_LABEL[s],
            color: STATUS_COLOR[s],
            value: String(current.counts[s] ?? 0),
          }))}
        />
      </div>
    </ChartCard>
  );
}
