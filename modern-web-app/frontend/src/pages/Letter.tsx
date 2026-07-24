import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import type { Application } from '../types';
import { Mountain } from '../components/Layout';
import { RidgeBand, Spinner, fmtDate } from '../components/Ui';

// The decision letter: what the city would have mailed. Rendered on Town Hall
// letterhead from the application record, sandbox-safe (nothing is actually
// sent). Outside the app chrome; always paper-white like the certificate.

export default function Letter() {
  const { id } = useParams<{ id: string }>();
  const [app, setApp] = useState<Application | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return;
    void api<{ application: Application }>(`/me/applications/${id}`, { auth: true })
      .then((r) => setApp(r.application))
      .catch((e: Error) => setError(e.message));
  }, [id]);

  if (error || (app && !app.decidedAt)) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <p className="text-stone-600 dark:text-stone-300">
          {error || 'A decision letter is written once the permit office decides the application.'}
        </p>
        <Link to={`/applications/${id}`} className="mt-4 inline-block font-semibold text-pine-700 dark:text-pine-300">
          ← Back to the application
        </Link>
      </div>
    );
  }
  if (!app) return <Spinner label="Preparing letter…" />;

  const approved = app.status === 'approved';

  return (
    <div className="min-h-screen bg-stone-200 py-8 dark:bg-stone-900 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-6 flex max-w-3xl items-center justify-between px-4">
        <Link
          to={`/applications/${id}`}
          className="text-sm font-semibold text-pine-800 hover:text-pine-950 dark:text-pine-300 dark:hover:text-pine-100"
        >
          ← Back to the application
        </Link>
        <button
          onClick={() => window.print()}
          className="rounded-lg bg-pine-800 px-4 py-2 text-sm font-bold text-white hover:bg-pine-700"
        >
          Print letter
        </button>
      </div>

      <div className="mx-auto max-w-3xl bg-white px-8 py-10 text-stone-900 shadow-xl sm:px-14 print:max-w-none print:shadow-none">
        <header className="flex items-center gap-4">
          <Mountain className="size-12 shrink-0" />
          <div>
            <p className="font-display text-lg font-bold text-pine-950">City of Alpenglow, Colorado</p>
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-stone-500">
              Office of Permits and Licensing · Town Hall, 100 Alpenglow Way · Alpenglow, CO 81600
            </p>
          </div>
        </header>
        <RidgeBand className="mt-4 h-[4px]" />

        <p className="mt-10 text-sm text-stone-600">{app.decidedAt ? fmtDate(app.decidedAt) : ''}</p>

        <div className="mt-6 text-sm leading-relaxed text-stone-800">
          <p className="font-semibold">{app.applicantName}</p>
          <p>{app.address}</p>
        </div>

        <p className="mt-8 text-sm font-bold text-stone-900">
          RE: {app.typeName} · Application <span className="font-mono">{app.id}</span>
        </p>

        <div className="mt-6 space-y-4 text-[15px] leading-relaxed text-stone-800">
          <p>Dear {app.applicantName.split(' ')[0]},</p>

          {approved ? (
            <>
              <p>
                The permit office has completed its review of your application for a{' '}
                <strong>{app.typeName.toLowerCase()}</strong> at {app.address}, and your permit has been{' '}
                <strong>approved</strong>.
              </p>
              {app.decisionNote && (
                <p>
                  From the reviewer's file: <em>"{app.decisionNote}"</em>
                </p>
              )}
              <p>
                Your permit certificate accompanies this letter. Please post it visibly at the work site before
                any work begins and keep it posted until all work is complete. City staff or any member of the
                public can confirm the permit at any time by scanning the code on the certificate.
              </p>
              <p>
                If the scope of your project changes, contact the counter at Window 03 before proceeding; a
                revised application may be required.
              </p>
            </>
          ) : (
            <>
              <p>
                The permit office has completed its review of your application for a{' '}
                <strong>{app.typeName.toLowerCase()}</strong> at {app.address}. We are unable to issue a permit
                at this time, and your application has been <strong>denied</strong>.
              </p>
              {app.decisionNote && (
                <p>
                  From the reviewer's file: <em>"{app.decisionNote}"</em>
                </p>
              )}
              <p>
                This decision is not a bar to reapplying. Most denials in Alpenglow are resolved by addressing
                the reviewer's note above and submitting a revised application, which you can do at any time
                from your resident account. The full record of actions on your application remains available to
                you online.
              </p>
            </>
          )}

          <p>
            Thank you for building in Alpenglow.
          </p>
        </div>

        <div className="mt-10 text-sm text-stone-800">
          <p className="font-display text-lg font-bold text-pine-950">Alpenglow Permit Office</p>
          <p className="mt-0.5 font-mono text-[11px] uppercase tracking-[0.14em] text-stone-500">
            Window 03 · Applications counter
          </p>
        </div>

        <RidgeBand className="mt-10 h-[4px]" />
        <p className="mt-4 text-[11px] leading-relaxed text-stone-400">
          Fictional demonstration document rendered in the browser. Nothing was mailed or emailed; the City of
          Alpenglow is not a real municipality.
        </p>
      </div>
    </div>
  );
}
