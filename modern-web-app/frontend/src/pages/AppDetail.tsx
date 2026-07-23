import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import type { Application, AppEvent, AppStatus } from '../types';
import { STATUS_LABEL } from '../types';
import { Card, ErrorNote, Spinner, StatusChip, WindowPlate, fmtDate } from '../components/Ui';

const DOT: Record<AppStatus, string> = {
  submitted: 'bg-stone-400',
  under_review: 'bg-amber-500',
  approved: 'bg-emerald-600',
  denied: 'bg-rose-600',
};

export default function AppDetail() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<{ application: Application; events: AppEvent[] } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return;
    void api<{ application: Application; events: AppEvent[] }>(`/me/applications/${id}`, { auth: true })
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [id]);

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <ErrorNote message={error} />
        <Link to="/dashboard" className="mt-4 inline-block text-sm font-semibold text-pine-700 dark:text-pine-300">
          ← Back to my applications
        </Link>
      </div>
    );
  }
  if (!data) return <Spinner label="Loading application…" />;

  const { application: app, events } = data;

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <Link to="/dashboard" className="text-sm font-semibold text-pine-700 hover:text-pine-900 dark:text-pine-300 dark:hover:text-pine-100">
        ← My applications
      </Link>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <WindowPlate n="04" label="Application record" />
          <h1 className="mt-3 font-display text-2xl font-bold text-pine-950 dark:text-pine-100">{app.typeName}</h1>
          <p className="mt-1 font-mono text-sm text-stone-500 dark:text-stone-400">{app.id}</p>
        </div>
        <StatusChip status={app.status} />
      </div>

      {app.decidedAt && (
        <div
          className={`mt-6 rounded-xl border px-5 py-4 text-sm ${
            app.status === 'approved'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200'
              : 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-200'
          }`}
        >
          <p className="font-bold">{app.status === 'approved' ? 'Permit approved' : 'Application denied'} · {fmtDate(app.decidedAt)}</p>
          {app.decisionNote && <p className="mt-1">{app.decisionNote}</p>}
        </div>
      )}

      <div className="mt-6 grid gap-6 md:grid-cols-5">
        <Card className="p-6 md:col-span-3">
          <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-stone-500 dark:text-stone-400">Application details</h2>
          <dl className="mt-4 space-y-4 text-sm">
            {(
              [
                ['Category', app.category],
                ['Project address', app.address],
                ['Description', app.description],
                ['Applicant', `${app.applicantName} (${app.applicantEmail})`],
                ['Submitted', fmtDate(app.submittedAt)],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dt className="font-semibold text-stone-500 dark:text-stone-400">{k}</dt>
                <dd className="mt-0.5 text-stone-800 dark:text-stone-200">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card className="p-6 md:col-span-2">
          <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-stone-500 dark:text-stone-400">Record of actions</h2>
          <ol className="mt-4 space-y-0">
            {events.map((ev, i) => (
              <li key={`${ev.at}-${i}`} className="relative pb-6 pl-6 last:pb-0">
                {i < events.length - 1 && <span className="absolute left-[5px] top-3 h-full w-px bg-stone-200 dark:bg-stone-700" />}
                <span className={`absolute left-0 top-1.5 size-2.5 rotate-45 rounded-[2px] ${DOT[ev.status]}`} />
                <p className="text-sm font-bold text-pine-950 dark:text-pine-100">{STATUS_LABEL[ev.status]}</p>
                <p className="font-mono text-[11px] text-stone-400">
                  {fmtDate(ev.at)} · {ev.actor}
                </p>
                {ev.note && <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">{ev.note}</p>}
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </div>
  );
}
