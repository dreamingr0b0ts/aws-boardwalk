import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import type { Application, AppEvent, AppStatus, Attachment } from '../types';
import { STATUS_LABEL } from '../types';
import { Card, ErrorNote, Spinner, StatusChip, WindowPlate, fmtDate } from '../components/Ui';

const DOT: Record<AppStatus, string> = {
  submitted: 'bg-stone-400',
  under_review: 'bg-amber-500',
  approved: 'bg-emerald-600',
  denied: 'bg-rose-600',
};

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

function fmtBytes(n?: number): string {
  if (!n) return '';
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function DocIcon({ contentType }: { contentType: string }) {
  const isPdf = contentType === 'application/pdf';
  return (
    <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {isPdf ? (
        <>
          <path d="M6 3h8l4 4v14H6z" />
          <path d="M14 3v4h4" />
          <path d="M9 13h6M9 16.5h4" />
        </>
      ) : (
        <>
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <circle cx="9" cy="10" r="1.5" />
          <path d="m4 17 5-4 3 2.5L16 12l4 4" />
        </>
      )}
    </svg>
  );
}

export default function AppDetail() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<{ application: Application; events: AppEvent[] } | null>(null);
  const [attachments, setAttachments] = useState<Attachment[] | null>(null);
  const [error, setError] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    if (!id) return;
    void api<{ application: Application; events: AppEvent[] }>(`/me/applications/${id}`, { auth: true })
      .then(setData)
      .catch((e: Error) => setError(e.message));
    void api<{ attachments: Attachment[] }>(`/me/applications/${id}/attachments`, { auth: true })
      .then((r) => setAttachments(r.attachments))
      .catch(() => setAttachments([]));
  }, [id]);

  useEffect(refresh, [refresh]);

  async function upload(file: File) {
    if (!id) return;
    setUploadError('');
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError('Documents can be up to 4 MB.');
      return;
    }
    setUploading(true);
    try {
      const presign = await api<{ attachmentId: string; upload: { url: string; fields: Record<string, string> } }>(
        `/me/applications/${id}/attachments`,
        { method: 'POST', auth: true, body: { filename: file.name, contentType: file.type } }
      );
      const form = new FormData();
      Object.entries(presign.upload.fields).forEach(([k, v]) => form.append(k, v));
      form.append('file', file);
      const res = await fetch(presign.upload.url, { method: 'POST', body: form });
      if (!res.ok) throw new Error('The storage service refused the upload.');
      await api(`/me/applications/${id}/attachments/${presign.attachmentId}/confirm`, { method: 'POST', auth: true });
      refresh();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

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
  const open = app.status === 'submitted' || app.status === 'under_review';

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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-bold">
                {app.status === 'approved' ? 'Permit approved' : 'Application denied'} · {fmtDate(app.decidedAt)}
              </p>
              {app.decisionNote && <p className="mt-1">{app.decisionNote}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              {app.status === 'approved' && (
                <Link
                  to={`/applications/${app.id}/certificate`}
                  className="rounded-lg bg-emerald-700 px-3.5 py-2 text-sm font-bold text-white hover:bg-emerald-600"
                >
                  View permit certificate
                </Link>
              )}
              <Link
                to={`/applications/${app.id}/letter`}
                className={`rounded-lg border px-3.5 py-2 text-sm font-bold ${
                  app.status === 'approved'
                    ? 'border-emerald-700/50 text-emerald-800 hover:bg-emerald-100 dark:text-emerald-200 dark:hover:bg-emerald-900/40'
                    : 'border-rose-600/50 text-rose-800 hover:bg-rose-100 dark:text-rose-200 dark:hover:bg-rose-900/40'
                }`}
              >
                View decision letter
              </Link>
            </div>
          </div>
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

      {/* Supporting documents: browser → S3 via presigned POST; the clerk logs
          each receipt in the record of actions. */}
      <Card className="mt-6 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-stone-500 dark:text-stone-400">Supporting documents</h2>
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              PDF, PNG, or JPEG · up to 4 MB each · 3 per application
              {!open && ' · the file is closed to new documents once decided'}
            </p>
          </div>
          {open && (
            <div>
              <input
                ref={fileInput}
                type="file"
                accept="application/pdf,image/png,image/jpeg"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void upload(f);
                }}
              />
              <button
                onClick={() => fileInput.current?.click()}
                disabled={uploading || (attachments?.length ?? 0) >= 3}
                className="rounded-lg bg-pine-800 px-4 py-2 text-sm font-bold text-white hover:bg-pine-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-pine-600 dark:hover:bg-pine-500"
              >
                {uploading ? 'Uploading…' : 'Add a document'}
              </button>
            </div>
          )}
        </div>

        {uploadError && <div className="mt-4"><ErrorNote message={uploadError} /></div>}

        {attachments === null && <p className="mt-4 text-sm text-stone-400">Loading documents…</p>}
        {attachments?.length === 0 && (
          <p className="mt-4 rounded-lg border border-dashed border-stone-300 px-4 py-6 text-center text-sm text-stone-400 dark:border-stone-700">
            No documents on file{open ? ' yet. Site plans and drawings help the reviewer decide faster.' : '.'}
          </p>
        )}
        {attachments && attachments.length > 0 && (
          <ul className="mt-4 divide-y divide-stone-100 dark:divide-stone-800">
            {attachments.map((att) => (
              <li key={att.attId} className="flex items-center gap-3 py-3">
                <span className="text-pine-700 dark:text-pine-300">
                  <DocIcon contentType={att.contentType} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-stone-800 dark:text-stone-200">{att.filename}</span>
                  <span className="block font-mono text-[11px] text-stone-400">
                    {fmtBytes(att.size)}{att.uploadedAt ? ` · received ${fmtDate(att.uploadedAt)}` : ''}
                  </span>
                </span>
                <a
                  href={att.downloadUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md px-3 py-1 text-sm font-semibold text-pine-700 hover:bg-pine-50 dark:text-pine-300 dark:hover:bg-pine-900/40"
                >
                  View
                </a>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
