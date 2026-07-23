import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Button, Card, ErrorNote, Field, Input, WindowPlate } from '../components/Ui';
import { Mountain } from '../components/Layout';
import loginAspens from '../assets/login-aspens-800.webp';

const DEMO_ACCOUNTS = [
  { role: 'Staff admin', email: 'admin@demo.planetek.org', password: 'Alpenglow-Admin1!', blurb: 'Review queue, decisions, metrics, catalog' },
  { role: 'Resident', email: 'citizen@demo.planetek.org', password: 'Alpenglow-Citizen1!', blurb: 'Submit and track applications' },
];

export default function Login() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const user = await signIn(email.trim(), password);
      navigate(from ?? (user.isAdmin ? '/admin' : '/dashboard'), { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-14 lg:flex-row">
      <div className="flex-1">
        <Card className="overflow-hidden">
          <div className="relative flex items-center gap-3 overflow-hidden bg-pine-950 px-6 py-6">
            {/* Aspen grove — Royce Fonseca via Unsplash */}
            <img src={loginAspens} alt="" aria-hidden decoding="async" className="absolute inset-0 size-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-r from-pine-950/90 via-pine-950/70 to-pine-900/40" aria-hidden />
            <Mountain className="relative size-10" />
            <div className="relative">
              <p className="font-display text-lg font-bold text-white">Sign in</p>
              <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-pine-100">Resident & staff portal</p>
            </div>
          </div>
          <form onSubmit={submit} className="space-y-4 px-6 py-6">
            {error && <ErrorNote message={error} />}
            <Field label="Email">
              <Input
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
              />
            </Field>
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
            <p className="text-center text-sm text-stone-500 dark:text-stone-400">
              New here?{' '}
              <Link to="/register" className="font-semibold text-pine-700 dark:text-pine-300 hover:text-pine-900">
                Create an account
              </Link>
            </p>
          </form>
        </Card>
      </div>

      <div className="flex-1">
        <WindowPlate label="Demo accounts" />
        <div className="mt-3 space-y-3">
          {DEMO_ACCOUNTS.map((acct) => (
            <Card key={acct.email} className="p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-bold text-pine-950 dark:text-pine-100">{acct.role}</p>
                  <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">{acct.blurb}</p>
                  <dl className="mt-3 space-y-1 font-mono text-xs text-stone-600 dark:text-stone-300">
                    <div className="flex gap-2">
                      <dt className="w-16 shrink-0 font-sans font-semibold text-stone-400">email</dt>
                      <dd className="break-all">{acct.email}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-16 shrink-0 font-sans font-semibold text-stone-400">password</dt>
                      <dd className="break-all">{acct.password}</dd>
                    </div>
                  </dl>
                </div>
                <Button
                  variant="outline"
                  onClick={() => {
                    setEmail(acct.email);
                    setPassword(acct.password);
                    setError('');
                  }}
                >
                  Use
                </Button>
              </div>
            </Card>
          ))}
        </div>
        <p className="mt-4 text-xs leading-relaxed text-stone-400">
          These credentials are intentionally public. This is a portfolio demonstration. All accounts and data reset
          nightly at 3am Mountain.
        </p>
      </div>
    </div>
  );
}
