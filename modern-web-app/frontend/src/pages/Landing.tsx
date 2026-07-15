import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { PermitType, StatsResponse } from '../types';
import { Card, fmtMoney } from '../components/Ui';

function Ridge() {
  return (
    <svg viewBox="0 0 900 260" className="w-full" aria-hidden preserveAspectRatio="xMidYMax slice">
      <defs>
        <linearGradient id="ridge-glow" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ee7351" stopOpacity="0.9" />
          <stop offset="1" stopColor="#c4401f" stopOpacity="0.15" />
        </linearGradient>
        <linearGradient id="ridge-back" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f59e83" stopOpacity="0.35" />
          <stop offset="1" stopColor="#f59e83" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M0 200 120 120 220 180 340 70 460 170 560 110 680 190 790 130 900 180V260H0Z" fill="url(#ridge-back)" />
      <path d="M0 240 90 170 200 220 330 120 470 210 600 150 720 225 830 175 900 210V260H0Z" fill="url(#ridge-glow)" />
    </svg>
  );
}

const CATEGORY_BADGE: Record<string, string> = {
  Building: 'bg-pine-100 text-pine-800 dark:bg-pine-900/60 dark:text-pine-200',
  Business: 'bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300',
  Events: 'bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-300',
  Housing: 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
};

export default function Landing() {
  const [types, setTypes] = useState<PermitType[] | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);

  useEffect(() => {
    void api<{ types: PermitType[] }>('/public/permit-types').then((r) => setTypes(r.types)).catch(() => setTypes([]));
    void api<StatsResponse>('/public/stats').then(setStats).catch(() => undefined);
  }, []);

  const processed12mo = stats?.monthly.reduce((sum, m) => sum + m.received, 0);
  const avgDays = stats?.monthly.at(-1)?.avgProcessingDays;

  return (
    <>
      <section className="relative overflow-hidden bg-gradient-to-b from-pine-950 to-pine-900 text-white">
        <div className="mx-auto max-w-6xl px-4 pb-8 pt-16 sm:pt-24">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-widest text-glow-300">City of Alpenglow, Colorado</p>
            <h1 className="mt-3 text-4xl font-extrabold leading-tight sm:text-5xl">
              Permits, without the line.
            </h1>
            <p className="mt-4 max-w-xl text-lg text-pine-100">
              Apply for city permits online, track every application in real time, and see exactly how the permit
              office is performing — all in one place.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                to="/apply"
                className="rounded-lg bg-glow-600 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-glow-600/25 transition-colors hover:bg-glow-500"
              >
                Start an application
              </Link>
              <a
                href="#catalog"
                className="rounded-lg border border-pine-400/60 px-5 py-2.5 text-sm font-bold text-pine-50 transition-colors hover:border-pine-200 hover:bg-pine-800"
              >
                Browse permit types
              </a>
            </div>

            {stats?.current && (
              <dl className="mt-10 flex flex-wrap gap-x-10 gap-y-4">
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-pine-300">Processed, 12 months</dt>
                  <dd className="text-2xl font-bold text-white">{processed12mo?.toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-pine-300">Avg processing time</dt>
                  <dd className="text-2xl font-bold text-white">{avgDays} days</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-pine-300">Open right now</dt>
                  <dd className="text-2xl font-bold text-white">
                    {stats.current.counts.submitted + stats.current.counts.under_review}
                  </dd>
                </div>
              </dl>
            )}
          </div>
        </div>
        <Ridge />
      </section>

      <section id="catalog" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold text-pine-950 dark:text-pine-100">Permit types</h2>
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
              Fees and typical processing times are published for every permit the city issues.
            </p>
          </div>
          <Link to="/stats" className="hidden text-sm font-semibold text-pine-700 hover:text-pine-900 dark:text-pine-300 dark:hover:text-pine-100 sm:block">
            Office performance →
          </Link>
        </div>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {types === null &&
            Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-44 animate-pulse rounded-xl border border-stone-200 bg-stone-100 dark:border-stone-800 dark:bg-stone-800" />
            ))}
          {types?.map((t) => (
            <Card key={t.slug} className="flex flex-col p-5">
              <span
                className={`self-start rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${CATEGORY_BADGE[t.category] ?? 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300'}`}
              >
                {t.category}
              </span>
              <h3 className="mt-3 font-bold leading-snug text-pine-950 dark:text-pine-100">{t.name}</h3>
              <p className="mt-1.5 line-clamp-3 flex-1 text-sm text-stone-500 dark:text-stone-400">{t.description}</p>
              <div className="mt-4 flex items-center justify-between border-t border-stone-100 pt-3 dark:border-stone-800 text-sm">
                <span className="font-semibold text-stone-700 dark:text-stone-300">{fmtMoney(t.fee)}</span>
                <span className="text-stone-500 dark:text-stone-400">~{t.processingDays} days</span>
              </div>
              <Link
                to="/apply"
                state={{ typeSlug: t.slug }}
                className="mt-3 text-sm font-semibold text-glow-600 hover:text-glow-700 dark:text-glow-400 dark:hover:text-glow-300"
              >
                Apply →
              </Link>
            </Card>
          ))}
        </div>
      </section>

      <section className="border-y border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
        <div className="mx-auto max-w-6xl px-4 py-16">
          <h2 className="text-2xl font-bold text-pine-950 dark:text-pine-100">How it works</h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-3">
            {[
              ['Create an account', 'Sign up with your email — or use the demo accounts on the sign-in page to explore instantly.'],
              ['Submit your application', 'Pick a permit type, describe the work, and submit. You get a tracking ID immediately.'],
              ['Track to decision', 'Watch status change from submitted to under review to decided, with reviewer notes at every step.'],
            ].map(([title, body], i) => (
              <div key={title} className="relative rounded-xl border border-stone-200 p-6 dark:border-stone-700">
                <span className="absolute -top-4 left-6 flex size-8 items-center justify-center rounded-full bg-pine-800 text-sm font-bold text-white">
                  {i + 1}
                </span>
                <h3 className="mt-2 font-bold text-pine-950 dark:text-pine-100">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-stone-500 dark:text-stone-400">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
