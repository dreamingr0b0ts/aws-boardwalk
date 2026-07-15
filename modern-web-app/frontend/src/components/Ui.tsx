import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import type { AppStatus } from '../types';
import { STATUS_LABEL } from '../types';

// ---------------------------------------------------------------------------
// Small shared UI kit — one place for the design language, light and dark.
// ---------------------------------------------------------------------------

const BUTTON_STYLES = {
  primary:
    'bg-pine-800 text-white hover:bg-pine-700 focus-visible:outline-pine-800 dark:bg-pine-600 dark:hover:bg-pine-500',
  accent: 'bg-glow-600 text-white hover:bg-glow-500 focus-visible:outline-glow-600',
  outline:
    'border border-stone-300 bg-white text-stone-700 hover:border-pine-400 hover:text-pine-800 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-300 dark:hover:border-pine-400 dark:hover:text-pine-200',
  danger: 'bg-rose-700 text-white hover:bg-rose-600 focus-visible:outline-rose-700',
  success: 'bg-emerald-700 text-white hover:bg-emerald-600 focus-visible:outline-emerald-700',
  ghost: 'text-pine-700 hover:bg-pine-50 dark:text-pine-300 dark:hover:bg-pine-900/40',
} as const;

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BUTTON_STYLES }) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_STYLES[variant]} ${className}`}
      {...props}
    />
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl border border-stone-200 bg-white shadow-sm dark:border-stone-800 dark:bg-stone-900 ${className}`}
    >
      {children}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-semibold text-stone-700 dark:text-stone-300">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-stone-500 dark:text-stone-400">{hint}</span>}
    </label>
  );
}

const INPUT_CLASS =
  'w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 placeholder:text-stone-400 focus:border-pine-500 focus:outline-none focus:ring-2 focus:ring-pine-100 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:placeholder:text-stone-500 dark:focus:border-pine-400 dark:focus:ring-pine-900';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={INPUT_CLASS} {...props} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${INPUT_CLASS} min-h-28`} {...props} />;
}

const STATUS_STYLES: Record<AppStatus, string> = {
  submitted:
    'bg-stone-100 text-stone-700 ring-stone-300 dark:bg-stone-800 dark:text-stone-300 dark:ring-stone-600',
  under_review:
    'bg-amber-50 text-amber-800 ring-amber-300 dark:bg-amber-950/60 dark:text-amber-300 dark:ring-amber-800',
  approved:
    'bg-emerald-50 text-emerald-800 ring-emerald-300 dark:bg-emerald-950/60 dark:text-emerald-300 dark:ring-emerald-800',
  denied: 'bg-rose-50 text-rose-800 ring-rose-300 dark:bg-rose-950/60 dark:text-rose-300 dark:ring-rose-800',
};

export function StatusChip({ status }: { status: AppStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${STATUS_STYLES[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-stone-500 dark:text-stone-400">
      <span
        className="size-5 animate-spin rounded-full border-2 border-stone-300 border-t-pine-600 dark:border-stone-600 dark:border-t-pine-400"
        aria-hidden
      />
      <span className="text-sm">{label}</span>
    </div>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <div
      className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-300"
      role="alert"
    >
      {message}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-stone-300 bg-white px-6 py-14 text-center dark:border-stone-700 dark:bg-stone-900">
      <p className="text-base font-semibold text-stone-700 dark:text-stone-300">{title}</p>
      {children && <div className="mt-3 text-sm text-stone-500 dark:text-stone-400">{children}</div>}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-pine-950/50 p-4 pt-[8vh] dark:bg-black/60"
      onClick={onClose}
    >
      <div
        className={`w-full ${wide ? 'max-w-2xl' : 'max-w-md'} rounded-xl bg-white shadow-2xl dark:bg-stone-900 dark:ring-1 dark:ring-stone-700`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-4 dark:border-stone-800">
          <h2 className="text-base font-bold text-stone-800 dark:text-stone-100">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-md px-2 py-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-800 dark:hover:text-stone-200"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

export function KpiTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="px-5 py-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">{label}</p>
      <p className="mt-1 text-3xl font-bold text-pine-900 dark:text-pine-100">{value}</p>
      {sub && <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{sub}</p>}
    </Card>
  );
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
