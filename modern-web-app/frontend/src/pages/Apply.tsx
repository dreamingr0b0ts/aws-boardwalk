import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import type { PermitType } from '../types';
import { Button, Card, ErrorNote, Field, Input, Spinner, Textarea, fmtMoney } from '../components/Ui';

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
        <Card className="p-8 text-center">
          <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-emerald-100 text-2xl dark:bg-emerald-900/50">✓</div>
          <h1 className="mt-4 font-display text-2xl font-bold text-pine-950 dark:text-pine-100">Application submitted</h1>
          <p className="mt-2 text-stone-500 dark:text-stone-400">
            Your tracking ID is <span className="font-mono font-semibold text-pine-900">{submittedId}</span>. The
            permit office will begin review shortly.
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
      <h1 className="font-display text-2xl font-bold text-pine-950 dark:text-pine-100">New permit application</h1>

      <ol className="mt-6 flex gap-2 text-xs font-bold">
        {(['Permit type', 'Details', 'Review & submit'] as const).map((label, i) => {
          const n = (i + 1) as Step;
          const state = n === step ? 'bg-pine-800 text-white' : n < step ? 'bg-pine-100 text-pine-800 dark:bg-pine-900/60 dark:text-pine-200' : 'bg-stone-100 text-stone-400 dark:bg-stone-800 dark:text-stone-500';
          return (
            <li key={label} className={`flex items-center gap-2 rounded-full px-3 py-1.5 ${state}`}>
              <span>{n}</span> {label}
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
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              {types.map((t) => (
                <button
                  key={t.slug}
                  onClick={() => setTypeSlug(t.slug)}
                  className={`rounded-xl border-2 bg-white p-4 text-left transition-colors dark:bg-stone-900 ${
                    typeSlug === t.slug ? 'border-glow-500 ring-2 ring-glow-100' : 'border-stone-200 hover:border-pine-300 dark:border-stone-700 dark:hover:border-pine-500'
                  }`}
                >
                  <p className="text-xs font-bold uppercase tracking-wide text-stone-400">{t.category}</p>
                  <p className="mt-1 font-bold text-pine-950 dark:text-pine-100">{t.name}</p>
                  <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
                    {fmtMoney(t.fee)} · ~{t.processingDays} days
                  </p>
                </button>
              ))}
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
        <Card className="mt-6 space-y-4 p-6">
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
        </Card>
      )}

      {step === 3 && selected && (
        <Card className="mt-6 p-6">
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
                <dt className="font-semibold text-stone-500 dark:text-stone-400">{k}</dt>
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
