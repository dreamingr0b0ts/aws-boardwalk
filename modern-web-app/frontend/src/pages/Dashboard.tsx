import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLang } from '../lib/i18n';
import type { Application } from '../types';
import { Card, CategoryTile, EmptyState, ErrorNote, InspectionChip, KpiTile, Spinner, StatusChip, WindowPlate, fmtDate } from '../components/Ui';

export default function Dashboard() {
  const { user } = useAuth();
  const { t } = useLang();
  const [apps, setApps] = useState<Application[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api<{ applications: Application[] }>('/me/applications', { auth: true })
      .then((r) => setApps(r.applications))
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <WindowPlate n="04" label={t('dash.window')} />
          <h1 className="mt-3 font-display text-2xl font-bold text-pine-950 dark:text-pine-100">{t('dash.h1')}</h1>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            {t('dash.signedInAs')} <span className="font-mono text-[13px]">{user?.email}</span>
          </p>
        </div>
        <Link
          to="/apply"
          className="rounded-lg bg-glow-600 px-4 py-2 text-sm font-bold text-white hover:bg-glow-500"
        >
          {t('dash.new')}
        </Link>
      </div>

      {apps && apps.length > 0 && (
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          <KpiTile
            label={t('dash.kpiOpen')}
            value={String(apps.filter((a) => a.status === 'submitted' || a.status === 'under_review').length)}
            sub={t('dash.kpiOpenSub')}
          />
          <KpiTile label={t('dash.kpiApproved')} value={String(apps.filter((a) => a.status === 'approved').length)} sub={t('dash.kpiApprovedSub')} />
          <KpiTile label={t('dash.kpiDenied')} value={String(apps.filter((a) => a.status === 'denied').length)} sub={t('dash.kpiDeniedSub')} />
        </div>
      )}

      <div className="mt-6 space-y-3">
        {error && <ErrorNote message={error} />}
        {!error && apps === null && <Spinner label={t('dash.loading')} />}
        {apps?.length === 0 && (
          <EmptyState title={t('dash.emptyTitle')}>
            <Link to="/apply" className="font-semibold text-glow-600">
              {t('dash.emptyCta')}
            </Link>
          </EmptyState>
        )}
        {apps?.map((app) => (
          <Link key={app.id} to={`/applications/${app.id}`} className="block">
            <Card className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 transition hover:-translate-y-0.5 hover:border-pine-300 hover:shadow-md dark:hover:border-pine-600">
              <CategoryTile category={app.category} />
              <div className="min-w-0 flex-1">
                <p className="font-bold text-pine-950 dark:text-pine-100">{app.typeName}</p>
                <p className="mt-0.5 truncate text-sm text-stone-500 dark:text-stone-400">
                  <span className="font-mono text-xs text-pine-700 dark:text-pine-300">{app.id}</span> · {app.address}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <span className="font-mono text-xs text-stone-500 dark:text-stone-400">{fmtDate(app.submittedAt)}</span>
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <StatusChip status={app.status} />
                  {app.inspection && app.inspection !== 'passed' && <InspectionChip state={app.inspection} />}
                </span>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
