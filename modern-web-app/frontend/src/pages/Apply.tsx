import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { useLang } from '../lib/i18n';
import type { PermitType } from '../types';
import {
  Button,
  Card,
  CategoryBadge,
  ErrorNote,
  Field,
  Grommet,
  Input,
  Spinner,
  Textarea,
  WindowPlate,
  fmtMoney,
} from '../components/Ui';

type Step = 1 | 2 | 3;

const ACCEPTED_DOC_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];
const MAX_DOC_BYTES = 4 * 1024 * 1024;
const MAX_DOCS = 3;

export default function Apply() {
  const { t: tr } = useLang();
  const preselect = (useLocation().state as { typeSlug?: string } | null)?.typeSlug;

  const [types, setTypes] = useState<PermitType[] | null>(null);
  const [step, setStep] = useState<Step>(1);
  const [typeSlug, setTypeSlug] = useState(preselect ?? '');
  const [address, setAddress] = useState('');
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [docError, setDocError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploadingDocs, setUploadingDocs] = useState(false);
  const [docWarning, setDocWarning] = useState(false);
  const [uploadedCount, setUploadedCount] = useState(0);
  const [error, setError] = useState('');
  const [submittedId, setSubmittedId] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  function queueFile(f: File) {
    setDocError('');
    if (!ACCEPTED_DOC_TYPES.includes(f.type) || f.size > MAX_DOC_BYTES) {
      setDocError(tr('apply.docBad'));
      return;
    }
    setFiles((prev) => (prev.length >= MAX_DOCS ? prev : [...prev, f]));
  }

  useEffect(() => {
    void api<{ types: PermitType[] }>('/public/permit-types')
      .then((r) => setTypes(r.types))
      .catch((e: Error) => setError(e.message));
  }, []);

  // Wizard steps are state changes on one route, so the router-level
  // ScrollToTop never fires; each step (and the confirmation) starts at the
  // top the way a page change would.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [step, submittedId]);

  const selected = types?.find((t) => t.slug === typeSlug);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ id: string }>('/me/applications', {
        method: 'POST',
        auth: true,
        body: { typeSlug, address: address.trim(), description: description.trim() },
      });

      // The record now exists; run the queued documents through the same
      // presign → S3 POST → confirm path the record page uses. A failed file
      // never blocks the submission itself.
      if (files.length > 0) {
        setUploadingDocs(true);
        let ok = 0;
        for (const f of files) {
          try {
            const presign = await api<{ attachmentId: string; upload: { url: string; fields: Record<string, string> } }>(
              `/me/applications/${res.id}/attachments`,
              { method: 'POST', auth: true, body: { filename: f.name, contentType: f.type } }
            );
            const form = new FormData();
            Object.entries(presign.upload.fields).forEach(([k, v]) => form.append(k, v));
            form.append('file', f);
            const up = await fetch(presign.upload.url, { method: 'POST', body: form });
            if (!up.ok) throw new Error('upload failed');
            await api(`/me/applications/${res.id}/attachments/${presign.attachmentId}/confirm`, {
              method: 'POST',
              auth: true,
            });
            ok += 1;
          } catch {
            setDocWarning(true);
          }
        }
        setUploadedCount(ok);
      }

      setSubmittedId(res.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setBusy(false);
      setUploadingDocs(false);
    }
  }

  if (submittedId) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16">
        <Card className="relative p-8 pt-10 text-center">
          <Grommet />
          <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-emerald-100 text-2xl dark:bg-emerald-900/50">✓</div>
          <h1 className="mt-4 font-display text-2xl font-bold text-pine-950 dark:text-pine-100">{tr('apply.doneTitle')}</h1>
          <p className="mt-4 font-mono text-[10.5px] font-medium uppercase tracking-[0.16em] text-stone-500 dark:text-stone-400">{tr('apply.yourNumber')}</p>
          <p className="mt-1 font-mono text-xl font-medium text-pine-900 dark:text-pine-100">{submittedId}</p>
          <p className="mt-3 text-stone-500 dark:text-stone-400">
            {tr('apply.doneBody')}
          </p>
          {uploadedCount > 0 && (
            <p className="mt-3 text-sm font-semibold text-emerald-800 dark:text-emerald-300">
              {uploadedCount === 1 ? tr('apply.docsDoneOne') : `${uploadedCount} ${tr('apply.docsDoneMany')}`}
            </p>
          )}
          {docWarning && (
            <p className="mt-3 rounded-lg border border-amber-500/60 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-200">
              {tr('apply.docsWarn')}
            </p>
          )}
          <div className="mt-8 flex justify-center gap-3">
            <Link to={`/applications/${submittedId}`} className="rounded-lg bg-pine-800 px-4 py-2 text-sm font-bold text-white hover:bg-pine-700">
              {tr('apply.track')}
            </Link>
            <Link to="/dashboard" className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-bold text-stone-600 dark:border-stone-600 dark:text-stone-300 hover:border-pine-400">
              {tr('apply.myApps')}
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <WindowPlate n="03" label={tr('apply.window')} />
      <h1 className="mt-3 font-display text-2xl font-bold text-pine-950 dark:text-pine-100">{tr('apply.h1')}</h1>

      {/* Trail-blaze stepper: each step is one of the diamond markers from the
          landing page's "How it works" cards, joined by a survey-line rule. */}
      <ol className="mt-8 flex flex-wrap items-center gap-x-3 gap-y-4 text-xs font-bold">
        {([tr('apply.step1'), tr('apply.step2'), tr('apply.step3')] as const).map((label, i) => {
          const n = (i + 1) as Step;
          const diamond =
            n === step
              ? 'bg-gradient-to-br from-glow-500 to-glow-700 text-white shadow-md shadow-glow-600/30'
              : n < step
                ? 'bg-pine-700 text-pine-50 dark:bg-pine-600'
                : 'border border-stone-300 bg-white text-stone-500 dark:text-stone-400 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-500';
          const caption =
            n === step
              ? 'text-pine-950 dark:text-pine-100'
              : n < step
                ? 'text-pine-700 dark:text-pine-300'
                : 'text-stone-500 dark:text-stone-400';
          return (
            <li key={label} className="flex items-center gap-3">
              {i > 0 && <span aria-hidden className="h-px w-6 bg-stone-300 dark:bg-stone-700" />}
              <span className={`flex size-7 rotate-45 items-center justify-center rounded-[6px] ${diamond}`}>
                <span className="-rotate-45 font-mono text-[13px] font-medium leading-none">{n < step ? '✓' : n}</span>
              </span>
              <span className={caption}>{label}</span>
            </li>
          );
        })}
      </ol>

      {error && <div className="mt-6"><ErrorNote message={error} /></div>}

      {step === 1 && (
        <>
          {types === null ? (
            <Spinner label={tr('apply.loadingTypes')} />
          ) : (
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              {/* Each permit type is a job-site placard, same language as the
                  landing catalog; picking one stamps it like a reviewed form. */}
              {types.map((t) => {
                const active = typeSlug === t.slug;
                return (
                  <button
                    key={t.slug}
                    onClick={() => setTypeSlug(t.slug)}
                    aria-pressed={active}
                    className={`relative flex flex-col rounded-xl border-2 bg-white p-4 pt-6 text-left transition dark:bg-stone-900 ${
                      active
                        ? 'border-glow-500 shadow-lg shadow-glow-600/10 dark:border-glow-400'
                        : 'border-stone-200 hover:-translate-y-0.5 hover:border-pine-300 hover:shadow-lg dark:border-stone-700 dark:hover:border-pine-500'
                    }`}
                  >
                    <Grommet />
                    {active && (
                      <span className="absolute right-3 top-3 rounded-[4px] border border-glow-500/70 bg-glow-50 px-2 py-[3px] font-mono text-[10.5px] font-medium uppercase leading-none tracking-[0.12em] text-glow-700 dark:bg-glow-600/15 dark:text-glow-300">
                        {tr('apply.selected')}
                      </span>
                    )}
                    <CategoryBadge category={t.category} />
                    <p className="mt-2.5 font-bold leading-snug text-pine-950 dark:text-pine-100">{t.name}</p>
                    <p className="mt-1.5 line-clamp-2 flex-1 text-sm text-stone-500 dark:text-stone-400">{t.description}</p>
                    <div className="mt-3.5 flex items-center justify-between border-t border-stone-100 pt-2.5 dark:border-stone-800">
                      <span className="font-mono text-[13px] font-medium text-stone-700 dark:text-stone-300">{fmtMoney(t.fee)}</span>
                      <span className="font-mono text-xs text-stone-500 dark:text-stone-400">~{t.processingDays} {tr('apply.days')}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          <div className="mt-6 flex justify-end">
            <Button onClick={() => setStep(2)} disabled={!typeSlug}>
              {tr('apply.continue')}
            </Button>
          </div>
        </>
      )}

      {step === 2 && (
        <Card className="relative mt-6 p-6 pt-8">
          <Grommet />
          <div className="flex items-baseline justify-between gap-3 border-b border-stone-100 pb-3 dark:border-stone-800">
            <p className="font-mono text-[10.5px] font-medium uppercase tracking-[0.16em] text-stone-500 dark:text-stone-400">
              {tr('apply.formB')}
            </p>
            {selected && <span className="truncate text-xs font-semibold text-pine-700 dark:text-pine-300">{selected.name}</span>}
          </div>
          <div className="mt-5 space-y-4">
            <Field label={tr('apply.address')} hint={tr('apply.addressHint')}>
              <Input
                required
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="1420 Larkspur Lane, Alpenglow, CO"
              />
            </Field>
            <Field label={tr('apply.describe')} hint={`${description.trim().length}/2000 ${tr('apply.chars')}`}>
              <Textarea
                required
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={tr('apply.descPlaceholder')}
              />
            </Field>

            {/* Optional documents, queued locally; they upload right after the
                record is created so the reviewer sees them on first touch. */}
            <div className="rounded-lg border border-dashed border-stone-300 px-4 py-4 dark:border-stone-700">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-stone-700 dark:text-stone-300">{tr('detail.docsTitle')}</p>
                  <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">{tr('detail.docsRules')}</p>
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  accept="application/pdf,image/png,image/jpeg"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) queueFile(f);
                    if (fileInput.current) fileInput.current.value = '';
                  }}
                />
                <Button type="button" variant="outline" onClick={() => fileInput.current?.click()} disabled={files.length >= MAX_DOCS}>
                  {tr('detail.addDoc')}
                </Button>
              </div>
              {docError && <p className="mt-3 text-sm text-rose-700 dark:text-rose-300">{docError}</p>}
              {files.length > 0 && (
                <ul className="mt-3 divide-y divide-stone-100 dark:divide-stone-800">
                  {files.map((f, i) => (
                    <li key={`${f.name}-${i}`} className="flex items-center gap-3 py-2 text-sm">
                      <span className="min-w-0 flex-1 truncate font-semibold text-stone-700 dark:text-stone-300">{f.name}</span>
                      <span className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
                        {f.size >= 1048576 ? `${(f.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(f.size / 1024))} KB`}
                      </span>
                      <button
                        type="button"
                        onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                        className="rounded-md px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-900/40"
                      >
                        {tr('apply.remove')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(1)}>
                {tr('apply.back')}
              </Button>
              <Button onClick={() => setStep(3)} disabled={address.trim().length < 5 || description.trim().length < 10}>
                {tr('apply.review')}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {step === 3 && selected && (
        <Card className="relative mt-6 p-6 pt-8">
          <Grommet />
          <p className="border-b border-stone-100 pb-3 font-mono text-[10.5px] font-medium uppercase tracking-[0.16em] text-stone-500 dark:text-stone-400 dark:border-stone-800">
            {tr('apply.formC')}
          </p>
          <dl className="divide-y divide-stone-100 dark:divide-stone-800 text-sm">
            {(
              [
                [tr('apply.reviewType'), selected.name],
                [tr('apply.reviewCategory'), selected.category],
                [tr('apply.reviewAddress'), address],
                [tr('apply.reviewDesc'), description],
                [tr('apply.reviewDocs'), files.length > 0 ? files.map((f) => f.name).join(', ') : tr('apply.docsNone')],
                [tr('apply.reviewProcessing'), `~${selected.processingDays} ${tr('apply.days')}`],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="grid grid-cols-3 gap-4 py-3">
                <dt className="pt-0.5 font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-stone-500 dark:text-stone-400">
                  {k}
                </dt>
                <dd className="col-span-2 text-stone-800 dark:text-stone-200">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-4 rounded-lg bg-pine-50 px-4 py-3 text-sm text-pine-900 dark:bg-pine-900/40 dark:text-pine-100">
            {tr('apply.feeNoteA')} <strong>{fmtMoney(selected.fee)}</strong>{tr('apply.feeNoteB')}
          </div>
          <div className="mt-6 flex justify-between">
            <Button variant="outline" onClick={() => setStep(2)}>
              {tr('apply.back')}
            </Button>
            <Button variant="accent" onClick={() => void submit()} disabled={busy}>
              {uploadingDocs ? tr('apply.uploadingDocs') : busy ? tr('apply.submitting') : tr('apply.submit')}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
