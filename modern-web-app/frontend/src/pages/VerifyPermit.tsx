import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { AppStatus, VerifyRecord } from '../types';
import { Card, Spinner, StatusChip, WindowPlate, fmtDate } from '../components/Ui';

// Public field verification: the QR code on a printed certificate lands here.
// No sign-in — an inspector at the job site checks the register and gets a
// clear verdict stamp.

const VERDICT: Record<AppStatus, { label: string; blurb: string; cls: string }> = {
  approved: {
    label: 'Valid permit',
    blurb: 'This permit is on file and active in the City of Alpenglow permit register.',
    cls: 'border-emerald-600/60 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-200',
  },
  submitted: {
    label: 'Pending: not issued',
    blurb: 'An application with this number is on file but no permit has been issued. Work may not begin.',
    cls: 'border-amber-500/60 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-200',
  },
  under_review: {
    label: 'Pending: not issued',
    blurb: 'An application with this number is under review. No permit has been issued and work may not begin.',
    cls: 'border-amber-500/60 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-200',
  },
  denied: {
    label: 'No valid permit',
    blurb: 'The application under this number was denied. No permit is in force at this address.',
    cls: 'border-rose-500/60 bg-rose-50 text-rose-900 dark:border-rose-700 dark:bg-rose-950/50 dark:text-rose-200',
  },
};

export default function VerifyPermit() {
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
      <WindowPlate n="02" label="Permit register" />
      <h1 className="mt-3 font-display text-2xl font-bold text-pine-950 dark:text-pine-100">Permit verification</h1>
      <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
        Checked live against the same register the permit office uses. No account required.
      </p>

      {!data && !error && <Spinner label="Checking the register…" />}

      {error && (
        <div className="mt-8 rounded-xl border-2 border-rose-500/60 bg-rose-50 p-6 text-rose-900 dark:border-rose-700 dark:bg-rose-950/50 dark:text-rose-200">
          <p className="-rotate-1 inline-block rounded-[4px] border-2 border-current px-3 py-1.5 font-mono text-sm font-medium uppercase tracking-[0.14em]">
            {error.status === 404 ? 'Not on file' : 'Check failed'}
          </p>
          <p className="mt-3 text-sm">
            {error.status === 404
              ? `No permit or application numbered ${id} exists in the Alpenglow register.`
              : error.message}
          </p>
        </div>
      )}

      {data && (
        <>
          <div className={`mt-8 rounded-xl border-2 p-6 ${VERDICT[data.record.status].cls}`}>
            <p className="-rotate-1 inline-block rounded-[4px] border-2 border-current px-3 py-1.5 font-mono text-sm font-medium uppercase tracking-[0.14em]">
              {VERDICT[data.record.status].label}
            </p>
            <p className="mt-3 text-sm">{VERDICT[data.record.status].blurb}</p>
          </div>

          <Card className="mt-6 overflow-hidden">
            <div className="border-b border-stone-100 bg-stone-50 px-5 py-3 dark:border-stone-800 dark:bg-stone-950/60">
              <p className="font-mono text-[10.5px] font-medium uppercase tracking-[0.16em] text-stone-500 dark:text-stone-400">
                Register entry
              </p>
            </div>
            <dl className="divide-y divide-stone-100 px-5 text-sm dark:divide-stone-800">
              {(
                [
                  ['Number', data.record.id],
                  ['Permit type', data.record.typeName],
                  ['Category', data.record.category],
                  ['Work site', data.record.address],
                  ['Holder', data.record.holder],
                  ['Submitted', fmtDate(data.record.submittedAt)],
                  ['Decided', data.record.decidedAt ? fmtDate(data.record.decidedAt) : 'Pending'],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="grid grid-cols-3 gap-4 py-3">
                  <dt className="font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-stone-500 dark:text-stone-400 pt-0.5">
                    {k}
                  </dt>
                  <dd className="col-span-2 text-stone-800 dark:text-stone-200">
                    {k === 'Number' ? <span className="font-mono text-[13px]">{v}</span> : v}
                  </dd>
                </div>
              ))}
              <div className="grid grid-cols-3 gap-4 py-3">
                <dt className="font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-stone-500 dark:text-stone-400 pt-0.5">
                  Status
                </dt>
                <dd className="col-span-2">
                  <StatusChip status={data.record.status} />
                </dd>
              </div>
            </dl>
          </Card>

          <p className="mt-5 font-mono text-[11px] uppercase tracking-[0.08em] text-stone-400">
            Checked against the live register ·{' '}
            {new Date(data.checkedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
          </p>
        </>
      )}

      <p className="mt-8 text-sm text-stone-500 dark:text-stone-400">
        Have a permit number to check?{' '}
        <Link to="/" className="font-semibold text-pine-700 hover:text-pine-900 dark:text-pine-300 dark:hover:text-pine-100">
          Learn about Alpenglow permits →
        </Link>
      </p>
    </div>
  );
}
