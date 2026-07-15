import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Button, Card, ErrorNote, Field, Input } from '../components/Ui';

export default function Register() {
  const { signUp, confirm, signIn } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState<'form' | 'confirm'>('form');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submitForm(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await signUp(email.trim(), password, name.trim());
      setStep('confirm');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-up failed');
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await confirm(email.trim(), code.trim());
      await signIn(email.trim(), password);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Confirmation failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md px-4 py-14">
      <Card className="p-6">
        <h1 className="text-xl font-bold text-pine-950 dark:text-pine-100">Create a resident account</h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Real sign-up flow with email verification. Prefer not to? Use the{' '}
          <Link to="/login" className="font-semibold text-pine-700 dark:text-pine-300">
            demo accounts
          </Link>
          .
        </p>

        {step === 'form' ? (
          <form onSubmit={submitForm} className="mt-6 space-y-4">
            {error && <ErrorNote message={error} />}
            <Field label="Full name">
              <Input required minLength={2} value={name} onChange={(e) => setName(e.target.value)} placeholder="Jordan Rivera" />
            </Field>
            <Field label="Email" hint="A verification code will be sent here.">
              <Input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </Field>
            <Field label="Password" hint="12+ characters with upper, lower, number, and symbol.">
              <Input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? 'Creating…' : 'Create account'}
            </Button>
          </form>
        ) : (
          <form onSubmit={submitCode} className="mt-6 space-y-4">
            {error && <ErrorNote message={error} />}
            <p className="rounded-lg bg-pine-50 px-4 py-3 text-sm text-pine-900 dark:bg-pine-900/40 dark:text-pine-100">
              We emailed a 6-digit code to <strong>{email}</strong>.
            </p>
            <Field label="Verification code">
              <Input
                inputMode="numeric"
                pattern="[0-9]{6}"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
              />
            </Field>
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? 'Verifying…' : 'Verify & sign in'}
            </Button>
          </form>
        )}

        <p className="mt-6 text-xs leading-relaxed text-stone-400">
          Demo environment: accounts created here are removed by the nightly reset.
        </p>
      </Card>
    </div>
  );
}
