import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useLang } from '../lib/i18n';
import type { AppStatus, VerifyRecord } from '../types';
import { Card, InspectionChip, Spinner, StatusChip, WindowPlate, fmtDate } from '../components/Ui';

// Public field verification: the QR code on a printed certificate lands here.
// No sign-in — an inspector at the job site checks the register and gets a
// clear verdict stamp.

const VERDICT_CLS: Record<AppStatus, string> = {
  approved: 'border-emerald-600/60 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-200',
  submitted: 'border-amber-500/60 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-200',
  under_review: 'border-amber-500/60 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-200',
  denied: 'border-rose-500/60 bg-rose-50 text-rose-900 dark:border-rose-700 dark:bg-rose-950/50 dark:text-rose-200',
};
const VERDICT_LABEL: Record<AppStatus, string> = {
  approved: 'verify.v.approved',
  submitted: 'verify.v.pending',
  under_review: 'verify.v.pending',
  denied: 'verify.v.denied',
};
const VERDICT_BLURB: Record<AppStatus, string> = {
  approved: 'verify.v.approvedBody',
  submitted: 'verify.v.submittedBody',
  under_review: 'verify.v.reviewBody',
  denied: 'verify.v.deniedBody',
};

export default function VerifyPermit() {
  const { t, lang } = useLang();
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<{ record: VerifyRecord; checkedAt: string } | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);

  useEffect(() => {
    if (!id) return;
    setData(null);
    setError(null);
    void api<{ record: VerifyRecord; checkedAt: string }>(`/public/verify/${encodeURIComponent(id)}`)
      .then(setData)
      .catch((e: unknown) => {
        if (e instanceof ApiError) setError({ status: e.status, message: e.message });
        else setError({ status: 0, message: 'Could not reach the permit register' });
      });
  }, [id]);

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <WindowPlate n="02" label={t('verify.window')} />
      <h1 className="mt-3 font-display text-2xl font-bold text-pine-950 dark:text-pine-100">{t('verify.h1')}</h1>
      <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
        {t('verify.sub')}
      </p>

      {!data && !error && <Spinner label={t('verify.checking')} />}

      {error && (
        <div className="mt-8 rounded-xl border-2 border-rose-500/60 bg-rose-50 p-6 text-rose-900 dark:border-rose-700 dark:bg-rose-950/50 dark:text-rose-200">
          <p className="-rotate-1 inline-block rounded-[4px] border-2 border-current px-3 py-1.5 font-mono text-sm font-medium uppercase tracking-[0.14em]">
            {error.status === 404 ? t('verify.notFoundStamp') : t('verify.failedStamp')}
          </p>
          <p className="mt-3 text-sm">
            {error.status === 404
              ? `${t('verify.notFoundBody')} ${id} ${t('verify.notFoundTail')}`
              : error.message}
          </p>
        </div>
      )}

      {data && (
        <>
          <div className={`mt-8 rounded-xl border-2 p-6 ${VERDICT_CLS[data.record.status]}`}>
            <p className="-rotate-1 inline-block rounded-[4px] border-2 border-current px-3 py-1.5 font-mono text-sm font-medium uppercase tracking-[0.14em]">
              {t(VERDICT_LABEL[data.record.status])}
            </p>
            <p className="mt-3 text-sm">{t(VERDICT_BLURB[data.record.status])}</p>
          </div>

          <Card className="mt-6 overflow-hidden">
            <div className="border-b border-stone-100 bg-stone-50 px-5 py-3 dark:border-stone-800 dark:bg-stone-950/60">
              <p className="font-mono text-[10.5px] font-medium uppercase tracking-[0.16em] text-stone-500 dark:text-stone-400">
                {t('verify.entry')}
              </p>
            </div>
            <dl className="divide-y divide-stone-100 px-5 text-sm dark:divide-stone-800">
              {(
                [
                  [t('verify.number'), data.record.id],
                  [t('verify.type'), data.record.typeName],
                  [t('verify.category'), data.record.category],
                  [t('verify.site'), data.record.address],
                  [t('verify.holder'), data.record.holder],
                  [t('verify.submitted'), fmtDate(data.record.submittedAt)],
                  [t('verify.decided'), data.record.decidedAt ? fmtDate(data.record.decidedAt) : t('verify.pending')],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="grid grid-cols-3 gap-4 py-3">
                  <dt className="font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-stone-500 dark:text-stone-400 pt-0.5">
                    {k}
                  </dt>
                  <dd className="col-span-2 text-stone-800 dark:text-stone-200">
                    {k === t('verify.number') ? <span className="font-mono text-[13px]">{v}</span> : v}
                  </dd>
                </div>
              ))}
              <div className="grid grid-cols-3 gap-4 py-3">
                <dt className="font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-stone-500 dark:text-stone-400 pt-0.5">
                  {t('verify.status')}
                </dt>
                <dd className="col-span-2">
                  <StatusChip status={data.record.status} />
                </dd>
              </div>
              {data.record.inspection && (
                <div className="grid grid-cols-3 gap-4 py-3">
                  <dt className="font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-stone-500 dark:text-stone-400 pt-0.5">
                    {t('verify.inspection')}
                  </dt>
                  <dd className="col-span-2 flex flex-wrap items-center gap-2">
                    <InspectionChip state={data.record.inspection} />
                    {data.record.inspection === 'passed' && data.record.closedAt && (
                      <span className="text-sm text-stone-600 dark:text-stone-300">{t('verify.closedOut')} {fmtDate(data.record.closedAt)}</span>
                    )}
                  </dd>
                </div>
              )}
            </dl>
          </Card>

          <p className="mt-5 font-mono text-[11px] uppercase tracking-[0.08em] text-stone-500 dark:text-stone-400">
            {t('verify.checkedAt')} ·{' '}
            {new Date(data.checkedAt).toLocaleString(lang === 'es' ? 'es-US' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' })}
          </p>
        </>
      )}

      <p className="mt-8 text-sm text-stone-500 dark:text-stone-400">
        {t('verify.haveNumber')}{' '}
        <Link to="/" className="font-semibold text-pine-700 hover:text-pine-900 dark:text-pine-300 dark:hover:text-pine-100">
          {t('verify.learn')}
        </Link>
      </p>
    </div>
  );
}
