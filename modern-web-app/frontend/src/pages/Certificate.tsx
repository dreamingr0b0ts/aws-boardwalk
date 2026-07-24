import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { api } from '../lib/api';
import type { Application } from '../types';
import { Mountain } from '../components/Layout';
import { RidgeBand, Spinner, fmtDate } from '../components/Ui';

// The permit placard, made literal: a print-ready certificate for an approved
// permit, with a QR code that resolves to the public register check. This
// route renders outside the app chrome so the sheet prints clean. The sheet
// itself is always paper-white: it is a physical document, not a themed page.

export default function Certificate() {
  const { id } = useParams<{ id: string }>();
  const [app, setApp] = useState<Application | null>(null);
  const [qr, setQr] = useState('');
  const [error, setError] = useState('');

  const verifyUrl = `${window.location.origin}/verify/${id}`;

  useEffect(() => {
    if (!id) return;
    void api<{ application: Application }>(`/me/applications/${id}`, { auth: true })
      .then((r) => setApp(r.application))
      .catch((e: Error) => setError(e.message));
    void QRCode.toDataURL(verifyUrl, {
      width: 480,
      margin: 1,
      color: { dark: '#16302e', light: '#ffffff' },
    }).then(setQr);
  }, [id, verifyUrl]);

  if (error || (app && app.status !== 'approved')) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <p className="text-stone-600 dark:text-stone-300">
          {error || 'A certificate is only issued once a permit is approved.'}
        </p>
        <Link to={`/applications/${id}`} className="mt-4 inline-block font-semibold text-pine-700 dark:text-pine-300">
          ← Back to the application
        </Link>
      </div>
    );
  }
  if (!app) return <Spinner label="Preparing certificate…" />;

  return (
    <div className="min-h-screen bg-stone-200 py-8 dark:bg-stone-900 print:bg-white print:py-0">
      {/* Toolbar: never printed */}
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
          Print certificate
        </button>
      </div>

      {/* The sheet */}
      <div className="relative mx-auto max-w-3xl border-4 border-double border-pine-900 bg-white px-8 py-10 text-stone-900 shadow-xl sm:px-12 print:max-w-none print:border-4 print:shadow-none">
        {/* Placard grommet */}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-4 size-4 -translate-x-1/2 rounded-full border-4 border-brass-400 bg-stone-100 shadow-inner"
        />

        <header className="mt-4 flex items-center justify-center gap-4 text-center">
          <Mountain className="size-14 shrink-0" />
          <div>
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-stone-500">
              City of Alpenglow, Colorado
            </p>
            <p className="font-display text-xl font-bold text-pine-950">Office of Permits and Licensing</p>
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-stone-400">
              Town Hall counter · Windows 01 to 05 · Elev 8,750 ft
            </p>
          </div>
        </header>

        <RidgeBand className="mt-6 h-[5px]" />

        <div className="mt-8 text-center">
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-stone-500">
            This certifies that a
          </p>
          <h1 className="mt-2 font-display text-4xl font-black leading-tight text-pine-950">{app.typeName}</h1>
          <p className="mt-3 inline-block rounded-[4px] border-2 border-emerald-700/60 bg-emerald-50 px-3 py-1.5 font-mono text-sm font-medium uppercase tracking-[0.16em] text-emerald-800">
            Permit granted
          </p>
        </div>

        <dl className="mx-auto mt-8 grid max-w-xl gap-x-8 gap-y-4 text-sm sm:grid-cols-2">
          {(
            [
              ['Permit number', app.id],
              ['Category', app.category],
              ['Issued to', app.applicantName],
              ['Date issued', app.decidedAt ? fmtDate(app.decidedAt) : ''],
              ['Work site', app.address],
              ['Application filed', fmtDate(app.submittedAt)],
            ] as const
          ).map(([k, v]) => (
            <div key={k}>
              <dt className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-stone-500">{k}</dt>
              <dd className={`mt-1 font-semibold text-stone-900 ${k === 'Permit number' ? 'font-mono' : ''}`}>{v}</dd>
            </div>
          ))}
        </dl>

        {app.decisionNote && (
          <div className="mx-auto mt-8 max-w-xl rounded-lg border border-stone-300 bg-stone-50 px-5 py-4">
            <p className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-stone-500">
              Conditions of approval
            </p>
            <p className="mt-1.5 text-sm text-stone-800">{app.decisionNote}</p>
          </div>
        )}

        <div className="mx-auto mt-10 flex max-w-xl items-center gap-6 border-t border-stone-200 pt-8">
          {qr && <img src={qr} alt={`QR code linking to ${verifyUrl}`} className="size-28 shrink-0" />}
          <div className="text-sm text-stone-600">
            <p className="font-bold text-stone-800">Verify this permit in the field.</p>
            <p className="mt-1">
              Scan the code, or visit the address below, to check this number against the city's live permit
              register.
            </p>
            <p className="mt-2 break-all font-mono text-xs text-pine-800">{verifyUrl}</p>
          </div>
        </div>

        <RidgeBand className="mt-10 h-[5px]" />
        <footer className="mt-5 text-center">
          <p className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-stone-500">
            Post this certificate visibly at the work site until all work is complete
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-stone-400">
            Fictional demonstration document. The City of Alpenglow is not a real municipality and this
            certificate conveys no authority of any kind.
          </p>
        </footer>
      </div>
    </div>
  );
}
