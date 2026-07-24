import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../lib/api';
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

export default function Apply() {
  const preselect = (useLocation().state as { typeSlug?: string } | null)?.typeSlug;

  const [types, setTypes] = useState<PermitType[] | null>(null);
  const [step, setStep] = useState<Step>(1);
  const [typeSlug, setTypeSlug] = useState(preselect ?? '');
  const [address, setAddress] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [submittedId, setSubmittedId] = useState('');

  useEffect(() => {
    void api<{ types: PermitType[] }>('/public/permit-types')
      .then((r) => setTypes(r.types))
      .catch((e: Error) => setError(e.message));
  }, []);

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
      setSubmittedId(res.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setBusy(false);
    }
  }

  if (submittedId) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16">
        <Card className="relative p-8 pt-10 text-center">
          <Grommet />
          <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-emerald-100 text-2xl dark:bg-emerald-900/50">✓</div>
          <h1 className="mt-4 font-display text-2xl font-bold text-pine-950 dark:text-pine-100">Application submitted</h1>
          <p className="mt-4 font-mono text-[10.5px] font-medium uppercase tracking-[0.16em] text-stone-400">Your number</p>
          <p className="mt-1 font-mono text-xl font-medium text-pine-900 dark:text-pine-100">{submittedId}</p>
          <p className="mt-3 text-stone-500 dark:text-stone-400">
            Keep it for your records. The permit office will begin review shortly.
          </p>
          <div className="mt-8 flex justify-center gap-3">
            <Link to={`/applications/${submittedId}`} className="rounded-lg bg-pine-800 px-4 py-2 text-sm font-bold text-white hover:bg-pine-700">
              Track it
            </Link>
            <Link to="/dashboard" className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-bold text-stone-600 dark:border-stone-600 dark:text-stone-300 hover:border-pine-400">
              My applications
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <WindowPlate n="03" label="Applications counter" />
      <h1 className="mt-3 font-display text-2xl font-bold text-pine-950 dark:text-pine-100">New permit application</h1>

      {/* Trail-blaze stepper: each step is one of the diamond markers from the
          landing page's "How it works" cards, joined by a survey-line rule. */}
      <ol className="mt-8 flex flex-wrap items-center gap-x-3 gap-y-4 text-xs font-bold">
        {(['Permit type', 'Details', 'Review & submit'] as const).map((label, i) => {
          const n = (i + 1) as Step;
          const diamond =
            n === step
              ? 'bg-gradient-to-br from-glow-500 to-glow-700 text-white shadow-md shadow-glow-600/30'
              : n < step
                ? 'bg-pine-700 text-pine-50 dark:bg-pine-600'
                : 'border border-stone-300 bg-white text-stone-400 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-500';
          const caption =
            n === step
              ? 'text-pine-950 dark:text-pine-100'
              : n < step
                ? 'text-pine-700 dark:text-pine-300'
                : 'text-stone-400 dark:text-stone-500';
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
            <Spinner label="Loading permit types…" />
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
                      <span className="absolute right-3 top-3 -rotate-3 rounded-[4px] border border-glow-500/70 bg-glow-50 px-2 py-[3px] font-mono text-[10.5px] font-medium uppercase leading-none tracking-[0.12em] text-glow-700 dark:bg-glow-600/15 dark:text-glow-300">
                        Selected
                      </span>
                    )}
                    <CategoryBadge category={t.category} />
                    <p className="mt-2.5 font-bold leading-snug text-pine-950 dark:text-pine-100">{t.name}</p>
                    <p className="mt-1.5 line-clamp-2 flex-1 text-sm text-stone-500 dark:text-stone-400">{t.description}</p>
                    <div className="mt-3.5 flex items-center justify-between border-t border-stone-100 pt-2.5 dark:border-stone-800">
                      <span className="font-mono text-[13px] font-medium text-stone-700 dark:text-stone-300">{fmtMoney(t.fee)}</span>
                      <span className="font-mono text-xs text-stone-500 dark:text-stone-400">~{t.processingDays} days</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          <div className="mt-6 flex justify-end">
            <Button onClick={() => setStep(2)} disabled={!typeSlug}>
              Continue
            </Button>
          </div>
        </>
      )}

      {step === 2 && (
        <Card className="relative mt-6 p-6 pt-8">
          <Grommet />
          <div className="flex items-baseline justify-between gap-3 border-b border-stone-100 pb-3 dark:border-stone-800">
            <p className="font-mono text-[10.5px] font-medium uppercase tracking-[0.16em] text-stone-400">
              Form 03-B · Project details
            </p>
            {selected && <span className="truncate text-xs font-semibold text-pine-700 dark:text-pine-300">{selected.name}</span>}
          </div>
          <div className="mt-5 space-y-4">
            <Field label="Project address" hint="Street address within Alpenglow city limits.">
              <Input
                required
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="1420 Larkspur Lane, Alpenglow, CO"
              />
            </Field>
            <Field label="Describe the work" hint={`${description.trim().length}/2000 characters (minimum 10)`}>
              <Textarea
                required
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={selected ? `Tell the permit office about your ${selected.name.toLowerCase()} project…` : ''}
              />
            </Field>
            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button onClick={() => setStep(3)} disabled={address.trim().length < 5 || description.trim().length < 10}>
                Review
              </Button>
            </div>
          </div>
        </Card>
      )}

      {step === 3 && selected && (
        <Card className="relative mt-6 p-6 pt-8">
          <Grommet />
          <p className="border-b border-stone-100 pb-3 font-mono text-[10.5px] font-medium uppercase tracking-[0.16em] text-stone-400 dark:border-stone-800">
            Form 03-C · Review and submit
          </p>
          <dl className="divide-y divide-stone-100 dark:divide-stone-800 text-sm">
            {(
              [
                ['Permit type', selected.name],
                ['Category', selected.category],
                ['Project address', address],
                ['Description', description],
                ['Typical processing', `~${selected.processingDays} days`],
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
            Permit fee: <strong>{fmtMoney(selected.fee)}</strong>, due at issuance. (No payment is collected in this
            demo.)
          </div>
          <div className="mt-6 flex justify-between">
            <Button variant="outline" onClick={() => setStep(2)}>
              Back
            </Button>
            <Button variant="accent" onClick={() => void submit()} disabled={busy}>
              {busy ? 'Submitting…' : 'Submit application'}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
