import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import type { Application, AppStatus, Attachment, Inspection, MetricsResponse, PermitType } from '../types';
import { STATUS_LABEL } from '../types';
import {
  Button,
  Card,
  CategoryBadge,
  EmptyState,
  ErrorNote,
  Field,
  InspectionChip,
  Input,
  KpiTile,
  Modal,
  Spinner,
  StatusChip,
  Textarea,
  WindowPlate,
  fmtDate,
  fmtMoney,
} from '../components/Ui';
import { MonthlyTrend, StatusBreakdown, TypeBar } from '../components/Charts';

type Tab = 'queue' | 'metrics' | 'types';
type Filter = AppStatus | 'all' | 'inspection_due';

const FILTERS: Filter[] = ['all', 'submitted', 'under_review', 'approved', 'denied', 'inspection_due'];
const FILTER_LABEL: Record<string, string> = { all: 'All', inspection_due: 'Inspections' };

export default function Admin() {
  const [tab, setTab] = useState<Tab>('queue');

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <WindowPlate n="05" label="Staff console" />
          <h1 className="mt-3 font-display text-2xl font-bold text-pine-950 dark:text-pine-100">Permit office</h1>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">Staff console: review queue, performance, and catalog.</p>
        </div>
        <div className="flex rounded-lg border border-stone-300 bg-white p-1 dark:border-stone-700 dark:bg-stone-900">
          {(
            [
              ['queue', 'Review queue'],
              ['metrics', 'Metrics'],
              ['types', 'Permit types'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`rounded-md px-4 py-1.5 text-sm font-semibold transition-colors ${
                tab === key ? 'bg-pine-800 text-white dark:bg-pine-600' : 'text-stone-600 hover:text-pine-900 dark:text-stone-400 dark:hover:text-pine-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-8">
        {tab === 'queue' && <QueueTab />}
        {tab === 'metrics' && <MetricsTab />}
        {tab === 'types' && <TypesTab />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function QueueTab() {
  const [filter, setFilter] = useState<Filter>('all');
  const [apps, setApps] = useState<Application[] | null>(null);
  const [counts, setCounts] = useState<Record<AppStatus, number> | null>(null);
  const [selected, setSelected] = useState<Application | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async (f: Filter) => {
    setApps(null);
    // "Inspections" is a working view over approved permits, not a status.
    const query = f === 'all' ? '' : f === 'inspection_due' ? '?status=approved' : `?status=${f}`;
    const [list, metrics] = await Promise.all([
      api<{ applications: Application[] }>(`/admin/applications${query}`, { auth: true }),
      api<MetricsResponse>('/admin/metrics', { auth: true }),
    ]);
    setApps(
      f === 'inspection_due'
        ? list.applications.filter((a) => a.inspection && a.inspection !== 'passed')
        : list.applications
    );
    if (metrics.current) setCounts(metrics.current.counts);
  }, []);

  useEffect(() => {
    load(filter).catch((e: Error) => setError(e.message));
  }, [filter, load]);

  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : null;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const n = f === 'all' ? total : f === 'inspection_due' ? undefined : counts?.[f];
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-full px-3.5 py-1.5 text-sm font-semibold transition-colors ${
                filter === f ? 'bg-pine-800 text-white dark:bg-pine-600' : 'border border-stone-300 bg-white text-stone-600 hover:border-pine-400 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-400'
              }`}
            >
              {FILTER_LABEL[f] ?? STATUS_LABEL[f as AppStatus]}
              {n !== null && n !== undefined && <span className="ml-1.5 opacity-70">{n}</span>}
            </button>
          );
        })}
      </div>

      <div className="mt-4">
        {error && <ErrorNote message={error} />}
        {!error && apps === null && <Spinner label="Loading queue…" />}
        {apps?.length === 0 && <EmptyState title="Nothing in this bucket" />}
        {apps && apps.length > 0 && (
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-stone-200 bg-stone-50 dark:border-stone-700 dark:bg-stone-950/60 text-left font-mono text-[10.5px] font-medium uppercase tracking-[0.12em] text-stone-500 dark:text-stone-400">
                  <th className="px-4 py-3">ID</th>
                  <th className="px-4 py-3">Applicant</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Submitted</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 dark:divide-stone-800">
                {apps.map((app) => (
                  <tr key={app.id} className="hover:bg-pine-50/60 dark:hover:bg-pine-900/20">
                    <td className="px-4 py-3 font-mono text-xs text-stone-500 dark:text-stone-400">{app.id}</td>
                    <td className="px-4 py-3 font-semibold text-stone-700 dark:text-stone-300">{app.applicantName}</td>
                    <td className="px-4 py-3 text-stone-600 dark:text-stone-400">{app.typeName}</td>
                    <td className="px-4 py-3 font-mono text-xs text-stone-500 dark:text-stone-400">{fmtDate(app.submittedAt)}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        <StatusChip status={app.status} />
                        {app.inspection && app.inspection !== 'passed' && <InspectionChip state={app.inspection} />}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setSelected(app)}
                        className="rounded-md px-3 py-1 text-sm font-semibold text-pine-700 hover:bg-pine-50 dark:text-pine-300 dark:hover:bg-pine-900/40"
                      >
                        {app.status === 'submitted' || app.status === 'under_review' || (app.inspection && app.inspection !== 'passed')
                          ? 'Review'
                          : 'View'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      {selected && (
        <ReviewModal
          app={selected}
          onClose={() => setSelected(null)}
          onDone={() => {
            setSelected(null);
            load(filter).catch((e: Error) => setError(e.message));
          }}
          onChanged={() => {
            load(filter).catch((e: Error) => setError(e.message));
          }}
        />
      )}
    </>
  );
}

/**
 * The inspection ledger inside the review modal: schedule when the phase is
 * open (required/failed), record pass/fail on the scheduled visit. A pass
 * finals the permit; a fail loops back to scheduling.
 */
function InspectionSection({ app, onChanged }: { app: Application; onChanged: () => void }) {
  const defaultDate = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
  const [state, setState] = useState(app.inspection!);
  const [list, setList] = useState<Inspection[] | null>(null);
  const [date, setDate] = useState(defaultDate);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadInsp = useCallback(() => {
    void api<{ inspections: Inspection[] }>(`/admin/applications/${app.id}/inspections`, { auth: true })
      .then((r) => setList(r.inspections))
      .catch(() => setList([]));
  }, [app.id]);

  useEffect(loadInsp, [loadInsp]);

  async function act(fn: () => Promise<unknown>, next: typeof state) {
    setBusy(true);
    setError('');
    try {
      await fn();
      setState(next);
      setNote('');
      loadInsp();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  const scheduled = list?.filter((i) => i.result === 'scheduled').at(-1);

  return (
    <div className="mt-5 border-t border-stone-200 pt-4 dark:border-stone-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-stone-500 dark:text-stone-400">
          Final inspection
        </h3>
        <InspectionChip state={state} />
      </div>

      {list && list.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {list.map((insp) => (
            <li key={insp.n} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-stone-400">
                Visit {String(insp.n).padStart(2, '0')}
              </span>
              <span className="text-stone-700 dark:text-stone-300">{fmtDate(`${insp.scheduledFor}T12:00:00Z`)}</span>
              <span
                className={`font-mono text-[10.5px] font-medium uppercase tracking-[0.12em] ${
                  insp.result === 'passed'
                    ? 'text-emerald-700 dark:text-emerald-300'
                    : insp.result === 'failed'
                      ? 'text-rose-700 dark:text-rose-300'
                      : 'text-amber-700 dark:text-amber-300'
                }`}
              >
                {insp.result}
              </span>
              {insp.note && <span className="w-full text-xs text-stone-500 dark:text-stone-400">{insp.note}</span>}
            </li>
          ))}
        </ul>
      )}

      {error && <div className="mt-3"><ErrorNote message={error} /></div>}

      {(state === 'required' || state === 'failed') && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-stone-600 dark:text-stone-400">
              {state === 'failed' ? 'Reinspection date' : 'Inspection date'}
            </span>
            <input
              type="date"
              value={date}
              min={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setDate(e.target.value)}
              className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100"
            />
          </label>
          <Button
            disabled={busy || !date}
            onClick={() =>
              void act(
                () =>
                  api(`/admin/applications/${app.id}/inspections`, {
                    method: 'POST',
                    auth: true,
                    body: { scheduledFor: date },
                  }),
                'scheduled'
              )
            }
          >
            {state === 'failed' ? 'Schedule reinspection' : 'Schedule inspection'}
          </Button>
        </div>
      )}

      {state === 'scheduled' && scheduled && (
        <div className="mt-3">
          <Field label="Inspector's note" hint="Required for a failed visit; recorded on the applicant-visible timeline.">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What the inspector found on site" />
          </Field>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button
              variant="danger"
              disabled={busy || note.trim().length < 5}
              onClick={() =>
                void act(
                  () =>
                    api(`/admin/applications/${app.id}/inspections/${scheduled.n}/result`, {
                      method: 'POST',
                      auth: true,
                      body: { result: 'fail', note: note.trim() },
                    }),
                  'failed'
                )
              }
            >
              Record fail
            </Button>
            <Button
              variant="success"
              disabled={busy}
              onClick={() =>
                void act(
                  () =>
                    api(`/admin/applications/${app.id}/inspections/${scheduled.n}/result`, {
                      method: 'POST',
                      auth: true,
                      body: { result: 'pass', note: note.trim() || undefined },
                    }),
                  'passed'
                )
              }
            >
              Record pass
            </Button>
          </div>
        </div>
      )}

      {state === 'passed' && (
        <p className="mt-3 text-sm text-emerald-800 dark:text-emerald-300">
          Permit closed out. The certificate and public register now show the completed inspection.
        </p>
      )}
    </div>
  );
}

function ReviewModal({
  app,
  onClose,
  onDone,
  onChanged,
}: {
  app: Application;
  onClose: () => void;
  onDone: () => void;
  onChanged: () => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attachments, setAttachments] = useState<Attachment[] | null>(null);

  useEffect(() => {
    void api<{ attachments: Attachment[] }>(`/admin/applications/${app.id}/attachments`, { auth: true })
      .then((r) => setAttachments(r.attachments))
      .catch(() => setAttachments([]));
  }, [app.id]);

  const actionable = app.status === 'submitted' || app.status === 'under_review';

  async function decide(action: 'start_review' | 'approve' | 'deny') {
    setBusy(true);
    setError('');
    try {
      await api(`/admin/applications/${app.id}/decision`, {
        method: 'POST',
        auth: true,
        body: { action, note: note.trim() || undefined },
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
      setBusy(false);
    }
  }

  return (
    <Modal title={app.typeName} onClose={onClose} wide>
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs text-stone-500 dark:text-stone-400">{app.id}</span>
        <StatusChip status={app.status} />
      </div>

      <dl className="mt-4 space-y-3 text-sm">
        {(
          [
            ['Applicant', `${app.applicantName} · ${app.applicantEmail}`],
            ['Address', app.address],
            ['Description', app.description],
            ['Submitted', fmtDate(app.submittedAt)],
          ] as const
        ).map(([k, v]) => (
          <div key={k}>
            <dt className="font-semibold text-stone-500 dark:text-stone-400">{k}</dt>
            <dd className="mt-0.5 text-stone-800 dark:text-stone-200">{v}</dd>
          </div>
        ))}
        {app.decisionNote && (
          <div>
            <dt className="font-semibold text-stone-500 dark:text-stone-400">Decision note</dt>
            <dd className="mt-0.5 text-stone-800 dark:text-stone-200">{app.decisionNote}</dd>
          </div>
        )}
        <div>
          <dt className="font-semibold text-stone-500 dark:text-stone-400">Supporting documents</dt>
          <dd className="mt-1">
            {attachments === null && <span className="text-stone-400">Checking the file…</span>}
            {attachments?.length === 0 && <span className="text-stone-400">None submitted</span>}
            {attachments && attachments.length > 0 && (
              <ul className="space-y-1">
                {attachments.map((att) => (
                  <li key={att.attId}>
                    <a
                      href={att.downloadUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-semibold text-pine-700 underline-offset-2 hover:underline dark:text-pine-300"
                    >
                      {att.filename}
                    </a>
                    <span className="ml-2 font-mono text-[11px] text-stone-400">
                      {att.size ? (att.size >= 1048576 ? `${(att.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(att.size / 1024))} KB`) : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>

      {error && <div className="mt-4"><ErrorNote message={error} /></div>}

      {app.status === 'approved' && app.inspection && <InspectionSection app={app} onChanged={onChanged} />}

      {actionable && (
        <div className="mt-5 border-t border-stone-200 pt-4 dark:border-stone-800">
          <Field label="Reviewer note" hint="Included in the applicant-visible timeline.">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional for review start; recommended for decisions." />
          </Field>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            {app.status === 'submitted' && (
              <Button variant="outline" disabled={busy} onClick={() => void decide('start_review')}>
                Start review
              </Button>
            )}
            <Button variant="danger" disabled={busy} onClick={() => void decide('deny')}>
              Deny
            </Button>
            <Button variant="success" disabled={busy} onClick={() => void decide('approve')}>
              Approve
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function MetricsTab() {
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [types, setTypes] = useState<PermitType[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    void api<MetricsResponse>('/admin/metrics', { auth: true }).then(setMetrics).catch((e: Error) => setError(e.message));
    void api<{ types: PermitType[] }>('/admin/permit-types', { auth: true }).then((r) => setTypes(r.types)).catch(() => undefined);
  }, []);

  if (error) return <ErrorNote message={error} />;
  if (!metrics?.current) return <Spinner label="Loading metrics…" />;

  const c = metrics.current;
  const received12 = metrics.monthly.reduce((s, m) => s + m.received, 0);
  const approved12 = metrics.monthly.reduce((s, m) => s + m.approved, 0);
  const typeNames = Object.fromEntries(types.map((t) => [t.slug, t.name]));

  return (
    <div className="grid gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Open queue" value={String(c.counts.submitted + c.counts.under_review)} sub={`${c.counts.submitted} awaiting first touch`} />
        <KpiTile label="Oldest untouched" value={`${metrics.oldestPendingDays} days`} sub="time since submission" />
        <KpiTile label="Approval rate" value={received12 ? `${Math.round((approved12 / received12) * 100)}%` : '—'} sub="trailing 12 months" />
        <KpiTile label="Avg processing" value={`${c.avgProcessingDays} days`} sub="decided applications in system" />
      </div>
      <MonthlyTrend monthly={metrics.monthly} />
      <div className="grid gap-6 lg:grid-cols-2">
        <TypeBar monthly={metrics.monthly} typeNames={typeNames} />
        <StatusBreakdown current={c} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const EMPTY_TYPE: PermitType = { slug: '', name: '', description: '', category: 'Building', fee: 100, processingDays: 14, active: true, requiresInspection: false };

function TypesTab() {
  const [types, setTypes] = useState<PermitType[] | null>(null);
  const [editing, setEditing] = useState<PermitType | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const r = await api<{ types: PermitType[] }>('/admin/permit-types', { auth: true });
    setTypes(r.types);
  }, []);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load]);

  return (
    <>
      <div className="flex justify-end">
        <Button variant="accent" onClick={() => setEditing({ ...EMPTY_TYPE })}>
          New permit type
        </Button>
      </div>

      <div className="mt-4">
        {error && <ErrorNote message={error} />}
        {!error && types === null && <Spinner label="Loading catalog…" />}
        {types && (
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-stone-200 bg-stone-50 dark:border-stone-700 dark:bg-stone-950/60 text-left font-mono text-[10.5px] font-medium uppercase tracking-[0.12em] text-stone-500 dark:text-stone-400">
                  <th className="px-4 py-3">Permit</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Fee</th>
                  <th className="px-4 py-3">Processing</th>
                  <th className="px-4 py-3">Visible</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 dark:divide-stone-800">
                {types.map((t) => (
                  <tr key={t.slug} className="hover:bg-pine-50/60 dark:hover:bg-pine-900/20">
                    <td className="px-4 py-3 font-semibold text-stone-700 dark:text-stone-300">{t.name}</td>
                    <td className="px-4 py-3">
                      <CategoryBadge category={t.category} />
                    </td>
                    <td className="px-4 py-3 text-stone-600 dark:text-stone-400">{fmtMoney(t.fee)}</td>
                    <td className="px-4 py-3 text-stone-500 dark:text-stone-400">~{t.processingDays} days</td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                          t.active ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300' : 'bg-stone-100 text-stone-500 dark:bg-stone-800 dark:text-stone-400'
                        }`}
                      >
                        {t.active ? 'Public' : 'Hidden'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setEditing(t)}
                        className="rounded-md px-3 py-1 text-sm font-semibold text-pine-700 hover:bg-pine-50 dark:text-pine-300 dark:hover:bg-pine-900/40"
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      {editing && (
        <TypeModal
          type={editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            load().catch((e: Error) => setError(e.message));
          }}
        />
      )}
    </>
  );
}

function TypeModal({ type, onClose, onDone }: { type: PermitType; onClose: () => void; onDone: () => void }) {
  const isNew = !type.slug;
  const [form, setForm] = useState(type);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/admin/permit-types', {
        method: 'POST',
        auth: true,
        body: { ...form, slug: form.slug || undefined },
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
      setBusy(false);
    }
  }

  return (
    <Modal title={isNew ? 'New permit type' : `Edit: ${type.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <ErrorNote message={error} />}
        <Field label="Name">
          <Input required minLength={3} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Category">
          <Input required value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
        </Field>
        <Field label="Description">
          <Textarea
            required
            minLength={10}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Fee (USD)">
            <Input
              type="number"
              min={0}
              required
              value={form.fee}
              onChange={(e) => setForm({ ...form, fee: Number(e.target.value) })}
            />
          </Field>
          <Field label="Processing days">
            <Input
              type="number"
              min={1}
              required
              value={form.processingDays}
              onChange={(e) => setForm({ ...form, processingDays: Number(e.target.value) })}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm font-semibold text-stone-700 dark:text-stone-300">
          <input
            type="checkbox"
            checked={form.active ?? true}
            onChange={(e) => setForm({ ...form, active: e.target.checked })}
            className="size-4 accent-pine-700"
          />
          Visible to the public
        </label>
        <label className="flex items-center gap-2 text-sm font-semibold text-stone-700 dark:text-stone-300">
          <input
            type="checkbox"
            checked={form.requiresInspection ?? false}
            onChange={(e) => setForm({ ...form, requiresInspection: e.target.checked })}
            className="size-4 accent-pine-700"
          />
          Requires a final inspection after approval
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
