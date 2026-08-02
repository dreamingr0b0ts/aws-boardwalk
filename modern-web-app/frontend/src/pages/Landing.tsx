import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useLang } from '../lib/i18n';
import type { PermitType, StatsResponse } from '../types';
import { Card, CategoryBadge, Grommet, RidgeBand, WindowPlate, fmtMoney } from '../components/Ui';
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
      <span className="size-1.5 rotate-45 bg-current" aria-hidden />
      <span className="-ml-1 h-px w-7 bg-current" aria-hidden />
      {children}
    </p>
  );
}

export default function Landing() {
  const { t } = useLang();
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
        <div className="absolute inset-0 -z-10 bg-gradient-to-r from-pine-950/95 via-pine-950/85 to-pine-950/50" aria-hidden />
        <div className="absolute inset-0 -z-10 bg-gradient-to-t from-pine-950/70 via-transparent to-pine-950/45" aria-hidden />

        <div className="mx-auto max-w-6xl px-4 pb-32 pt-20 sm:pb-40 sm:pt-28">
          <div className="max-w-2xl">
            <Eyebrow onDark>{t('landing.eyebrow')}</Eyebrow>
            <h1 className="mt-4 font-display text-5xl font-black leading-[1.05] tracking-tight text-balance sm:text-6xl">
              {t('landing.h1a')} <em className="italic text-glow-300">{t('landing.h1b')}</em>
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-pine-100">
              {t('landing.lede')}
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                to="/apply"
                className="rounded-lg bg-glow-600 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-glow-600/30 transition-colors hover:bg-glow-500"
              >
                {t('landing.ctaApply')}
              </Link>
              <a
                href="#catalog"
                className="rounded-lg bg-white/10 px-5 py-2.5 text-sm font-bold text-white ring-1 ring-white/30 backdrop-blur-sm transition-colors hover:bg-white/20"
              >
                {t('landing.ctaBrowse')}
              </a>
            </div>

            {stats?.current && (
              <dl className="mt-10 flex flex-wrap gap-3">
                {[
                  [t('landing.kpiProcessed'), processed12mo?.toLocaleString()],
                  [t('landing.kpiAvg'), `${avgDays} ${t('landing.days')}`],
                  [t('landing.kpiOpen'), String(stats.current.counts.submitted + stats.current.counts.under_review)],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl bg-pine-950/40 px-5 py-3 ring-1 ring-white/15 backdrop-blur-sm">
                    <dt className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-pine-200">{label}</dt>
                    <dd className="mt-1 font-mono text-2xl font-medium text-white">{value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </div>
        <RidgeBand className="absolute inset-x-0 bottom-0 h-[5px]" />
      </section>

      <section id="catalog" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16">
        <div className="flex items-end justify-between gap-4">
          <div>
            <WindowPlate n="01" label={t('landing.window01')} />
            <h2 className="mt-3 font-display text-3xl font-bold text-pine-950 dark:text-pine-100">
              {t('landing.catalogH2')}
            </h2>
            <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">
              {t('landing.catalogSub')}
            </p>
          </div>
          <Link to="/stats" className="hidden text-sm font-semibold text-pine-700 hover:text-pine-900 dark:text-pine-300 dark:hover:text-pine-100 sm:block">
            {t('landing.officePerf')}
          </Link>
        </div>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {types === null &&
            Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-44 animate-pulse rounded-xl border border-stone-200 bg-stone-100 dark:border-stone-800 dark:bg-stone-800" />
            ))}
          {types?.map((t2) => (
            <Card
              key={t2.slug}
              className="group relative flex flex-col p-5 pt-6 transition hover:-translate-y-0.5 hover:border-pine-300 hover:shadow-lg dark:hover:border-pine-600"
            >
              <Grommet />
              <CategoryBadge category={t2.category} />
              <h3 className="mt-3 font-bold leading-snug text-pine-950 dark:text-pine-100">{t2.name}</h3>
              <p className="mt-1.5 line-clamp-3 flex-1 text-sm text-stone-500 dark:text-stone-400">{t2.description}</p>
              <div className="mt-4 flex items-center justify-between border-t border-stone-100 pt-3 dark:border-stone-800 text-sm">
                <span className="font-mono text-[13px] font-medium text-stone-700 dark:text-stone-300">{fmtMoney(t2.fee)}</span>
                <span className="font-mono text-xs text-stone-500 dark:text-stone-400">~{t2.processingDays} {t('landing.daysAbout')}</span>
              </div>
              <Link
                to="/apply"
                state={{ typeSlug: t2.slug }}
                className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-glow-600 hover:text-glow-700 dark:text-glow-400 dark:hover:text-glow-300"
              >
                {t('landing.apply')}
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
        <div className="absolute inset-0 -z-10 bg-gradient-to-r from-pine-950/95 via-pine-950/80 to-pine-950/45" aria-hidden />
        <div className="mx-auto max-w-6xl px-4 py-20 sm:py-24">
          <div className="max-w-2xl">
            <WindowPlate n="02" label={t('landing.window02')} onDark />
            <h2 className="mt-3 font-display text-3xl font-bold leading-tight text-balance sm:text-4xl">
              {t('landing.transpH2a')} <em className="italic text-glow-300">{t('landing.transpH2b')}</em>
            </h2>
            <p className="mt-4 max-w-xl leading-relaxed text-pine-100">
              {t('landing.transpBody')}
            </p>
            <Link
              to="/stats"
              className="mt-8 inline-flex items-center gap-2 rounded-lg bg-white/10 px-5 py-2.5 text-sm font-bold text-white ring-1 ring-white/25 backdrop-blur-sm transition-colors hover:bg-white/20"
            >
              {t('landing.transpCta')}
            </Link>
          </div>
        </div>
      </section>

      <section className="relative overflow-hidden border-b border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
        <Contours className="pointer-events-none absolute -right-24 -top-20 size-[30rem] rotate-12 text-pine-800/[0.07] dark:text-pine-200/[0.06]" />
        <div className="relative mx-auto max-w-6xl px-4 py-16">
          <WindowPlate n="03" label={t('landing.window03')} />
          <h2 className="mt-3 font-display text-3xl font-bold text-pine-950 dark:text-pine-100">{t('landing.howH2')}</h2>
          <div className="mt-10 grid gap-6 sm:grid-cols-3">
            {[
              [t('landing.how1t'), t('landing.how1b')],
              [t('landing.how2t'), t('landing.how2b')],
              [t('landing.how3t'), t('landing.how3b')],
            ].map(([title, body], i) => (
              <div key={title} className="relative rounded-xl border border-stone-200 bg-white/80 p-6 backdrop-blur-sm dark:border-stone-700 dark:bg-stone-900/80">
                <span className="absolute -top-4 left-6 flex size-8 rotate-45 items-center justify-center rounded-[7px] bg-gradient-to-br from-glow-500 to-glow-700 shadow-md shadow-glow-600/30">
                  <span className="-rotate-45 font-mono text-sm font-medium text-white">{i + 1}</span>
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
