import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { PermitType, StatsResponse } from '../types';
import { Card, fmtMoney } from '../components/Ui';
import heroSm from '../assets/hero-alpenglow-800.webp';
import heroMd from '../assets/hero-alpenglow-1200.webp';
import heroLg from '../assets/hero-alpenglow-2000.webp';
import bandAspens from '../assets/band-aspens-1600.webp';

/* Concentric contour lines, a nod to the topographic maps every permit office
   keeps on the wall. Sits behind section content at low opacity. */
function Contours({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 400 400"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      className={className}
      aria-hidden
    >
      <path d="M200 28c78 0 150 36 172 100s-12 138-72 176-156 40-216-2S8 186 36 116 122 28 200 28Z" />
      <path d="M200 62c62 0 120 30 138 82s-10 110-58 140-124 32-172-2S48 190 70 134 138 62 200 62Z" />
      <path d="M200 96c47 0 90 24 104 63s-8 82-44 105-93 24-129-2S88 194 104 152 153 96 200 96Z" />
      <path d="M200 130c32 0 61 17 70 44s-5 55-30 71-62 16-87-1S128 196 139 168 168 130 200 130Z" />
      <path d="M200 164c17 0 32 9 37 24s-3 28-16 36-32 8-45 0S168 198 174 183 183 164 200 164Z" />
    </svg>
  );
}

function Eyebrow({ children, onDark = false }: { children: ReactNode; onDark?: boolean }) {
  return (
    <p
      className={`flex items-center gap-2.5 text-xs font-bold uppercase tracking-[0.22em] ${
        onDark ? 'text-glow-300' : 'text-glow-600 dark:text-glow-400'
      }`}
    >
      <span className="h-px w-8 bg-current" aria-hidden />
      {children}
    </p>
  );
}

const CATEGORY_BADGE: Record<string, string> = {
  Building: 'bg-pine-100 text-pine-800 dark:bg-pine-900/60 dark:text-pine-200',
  Business: 'bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300',
  Events: 'bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-300',
  Housing: 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
};

const CATEGORY_ICON: Record<string, ReactNode> = {
  Building: (
    <>
      <path d="M6 21V8h12v13" />
      <path d="M6 12h12M6 16.5h12" />
      <path d="M9.5 8V5h5v3" />
      <path d="M3 21h18" />
    </>
  ),
  Business: (
    <>
      <path d="M4 9 5.5 4h13L20 9" />
      <path d="M4.5 9v12h15V9" />
      <path d="M9.5 21v-6h5v6" />
    </>
  ),
  Events: (
    <>
      <path d="M5.5 21V4" />
      <path d="M5.5 5h13l-3 4 3 4h-13" />
    </>
  ),
  Housing: (
    <>
      <path d="m3 11.5 9-7.5 9 7.5" />
      <path d="M6 10v11h12V10" />
      <path d="M10 21v-6h4v6" />
    </>
  ),
};

function CategoryIcon({ category }: { category: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {CATEGORY_ICON[category] ?? (
        <>
          <rect x="6" y="4" width="12" height="17" rx="2" />
          <path d="M9 10h6M9 14h4" />
        </>
      )}
    </svg>
  );
}

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
      <section className="relative isolate overflow-hidden bg-pine-950 text-white">
        {/* Telluride, CO box canyon — Daniel Ribar via Unsplash (credit in footer + README) */}
        <img
          src={heroLg}
          srcSet={`${heroSm} 800w, ${heroMd} 1200w, ${heroLg} 2000w`}
          sizes="100vw"
          alt=""
          aria-hidden
          fetchPriority="high"
          decoding="async"
          className="absolute inset-0 -z-10 size-full object-cover object-[center_72%]"
        />
        <div className="absolute inset-0 -z-10 bg-gradient-to-r from-pine-950/90 via-pine-950/55 to-pine-950/20" aria-hidden />
        <div className="absolute inset-0 -z-10 bg-gradient-to-t from-pine-950/70 via-transparent to-pine-950/45" aria-hidden />

        <div className="mx-auto max-w-6xl px-4 pb-32 pt-20 sm:pb-40 sm:pt-28">
          <div className="max-w-2xl">
            <Eyebrow onDark>City of Alpenglow, Colorado</Eyebrow>
            <h1 className="mt-4 font-display text-5xl font-black leading-[1.05] tracking-tight text-balance sm:text-6xl">
              Permits, <em className="italic text-glow-300">without the line.</em>
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-pine-100">
              Apply for city permits online, track every application in real time, and see exactly how the permit
              office is performing, all in one place.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                to="/apply"
                className="rounded-lg bg-glow-600 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-glow-600/30 transition-colors hover:bg-glow-500"
              >
                Start an application
              </Link>
              <a
                href="#catalog"
                className="rounded-lg bg-white/10 px-5 py-2.5 text-sm font-bold text-white ring-1 ring-white/30 backdrop-blur-sm transition-colors hover:bg-white/20"
              >
                Browse permit types
              </a>
            </div>

            {stats?.current && (
              <dl className="mt-10 flex flex-wrap gap-3">
                {[
                  ['Processed, 12 months', processed12mo?.toLocaleString()],
                  ['Avg processing time', `${avgDays} days`],
                  ['Open right now', String(stats.current.counts.submitted + stats.current.counts.under_review)],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl bg-pine-950/40 px-5 py-3 ring-1 ring-white/15 backdrop-blur-sm">
                    <dt className="text-[11px] font-semibold uppercase tracking-wider text-pine-200">{label}</dt>
                    <dd className="mt-0.5 text-2xl font-bold text-white">{value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </div>
      </section>

      <section id="catalog" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16">
        <div className="flex items-end justify-between gap-4">
          <div>
            <Eyebrow>Permit catalog</Eyebrow>
            <h2 className="mt-2 font-display text-3xl font-bold text-pine-950 dark:text-pine-100">
              Everything the city issues
            </h2>
            <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">
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
            <Card
              key={t.slug}
              className="group flex flex-col p-5 transition hover:-translate-y-0.5 hover:border-pine-300 hover:shadow-lg dark:hover:border-pine-600"
            >
              <span
                className={`inline-flex items-center gap-1.5 self-start rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${CATEGORY_BADGE[t.category] ?? 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300'}`}
              >
                <CategoryIcon category={t.category} />
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
                className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-glow-600 hover:text-glow-700 dark:text-glow-400 dark:hover:text-glow-300"
              >
                Apply
                <span aria-hidden className="transition-transform group-hover:translate-x-0.5">→</span>
              </Link>
            </Card>
          ))}
        </div>
      </section>

      <section className="relative isolate overflow-hidden bg-pine-950 text-white">
        {/* Golden aspens below a dark peak — Alex Moliski via Unsplash */}
        <img
          src={bandAspens}
          alt=""
          aria-hidden
          loading="lazy"
          decoding="async"
          className="absolute inset-0 -z-10 size-full object-cover object-center"
        />
        <div className="absolute inset-0 -z-10 bg-gradient-to-r from-pine-950/90 via-pine-950/65 to-pine-950/35" aria-hidden />
        <div className="mx-auto max-w-6xl px-4 py-20 sm:py-24">
          <div className="max-w-2xl">
            <Eyebrow onDark>Transparency by default</Eyebrow>
            <h2 className="mt-3 font-display text-3xl font-bold leading-tight text-balance sm:text-4xl">
              The permit office <em className="italic text-glow-300">shows its work.</em>
            </h2>
            <p className="mt-4 max-w-xl leading-relaxed text-pine-100">
              Every application in this demo feeds a live public dashboard: volumes, decisions, and how long each
              step really takes. No records request required.
            </p>
            <Link
              to="/stats"
              className="mt-8 inline-flex items-center gap-2 rounded-lg bg-white/10 px-5 py-2.5 text-sm font-bold text-white ring-1 ring-white/25 backdrop-blur-sm transition-colors hover:bg-white/20"
            >
              See office performance →
            </Link>
          </div>
        </div>
      </section>

      <section className="relative overflow-hidden border-b border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
        <Contours className="pointer-events-none absolute -right-24 -top-20 size-[30rem] rotate-12 text-pine-800/[0.07] dark:text-pine-200/[0.06]" />
        <div className="relative mx-auto max-w-6xl px-4 py-16">
          <Eyebrow>Three steps</Eyebrow>
          <h2 className="mt-2 font-display text-3xl font-bold text-pine-950 dark:text-pine-100">How it works</h2>
          <div className="mt-10 grid gap-6 sm:grid-cols-3">
            {[
              ['Create an account', 'Sign up with your email, or use the demo accounts on the sign-in page to explore instantly.'],
              ['Submit your application', 'Pick a permit type, describe the work, and submit. You get a tracking ID immediately.'],
              ['Track to decision', 'Watch status change from submitted to under review to decided, with reviewer notes at every step.'],
            ].map(([title, body], i) => (
              <div key={title} className="relative rounded-xl border border-stone-200 bg-white/80 p-6 backdrop-blur-sm dark:border-stone-700 dark:bg-stone-900/80">
                <span className="absolute -top-4 left-6 flex size-8 items-center justify-center rounded-full bg-gradient-to-br from-glow-500 to-glow-700 text-sm font-bold text-white shadow-md shadow-glow-600/30">
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
