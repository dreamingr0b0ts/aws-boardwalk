import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Application } from '../types';
import { Card, EmptyState, ErrorNote, Spinner, StatusChip, fmtDate } from '../components/Ui';

export default function Dashboard() {
  const { user } = useAuth();
  const [apps, setApps] = useState<Application[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api<{ applications: Application[] }>('/me/applications', { auth: true })
      .then((r) => setApps(r.applications))
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-pine-950 dark:text-pine-100">My applications</h1>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">Signed in as {user?.email}</p>
        </div>
        <Link
          to="/apply"
          className="rounded-lg bg-glow-600 px-4 py-2 text-sm font-bold text-white hover:bg-glow-500"
        >
          New application
        </Link>
      </div>

      <div className="mt-8 space-y-3">
        {error && <ErrorNote message={error} />}
        {!error && apps === null && <Spinner label="Loading your applications…" />}
        {apps?.length === 0 && (
          <EmptyState title="No applications yet">
            <Link to="/apply" className="font-semibold text-glow-600">
              Start your first application →
            </Link>
          </EmptyState>
        )}
        {apps?.map((app) => (
          <Link key={app.id} to={`/applications/${app.id}`} className="block">
            <Card className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4 transition-shadow hover:shadow-md">
              <div className="min-w-0 flex-1">
                <p className="font-bold text-pine-950 dark:text-pine-100">{app.typeName}</p>
                <p className="mt-0.5 truncate text-sm text-stone-500 dark:text-stone-400">
                  <span className="font-mono text-xs">{app.id}</span> · {app.address}
                </p>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-sm text-stone-500 dark:text-stone-400">{fmtDate(app.submittedAt)}</span>
                <StatusChip status={app.status} />
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
