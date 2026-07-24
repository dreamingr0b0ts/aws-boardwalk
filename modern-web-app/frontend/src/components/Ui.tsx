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

/**
 * Counter-window plate — every area of the portal is a numbered service window
 * at the Town Hall counter: 01 catalog, 02 records, 03 applications, 04 my
 * applications, 05 staff. `n` empty gives an unnumbered plate (front desk).
 */
export function WindowPlate({ n, label, onDark = false }: { n?: string; label: string; onDark?: boolean }) {
  return (
    <p
      className={`inline-flex items-stretch overflow-hidden rounded-[5px] border text-[10.5px] font-medium uppercase leading-none tracking-[0.16em] ${
        onDark ? 'border-white/30' : 'border-pine-800/35 dark:border-pine-200/30'
      }`}
    >
      <span
        className={`flex items-center gap-1 px-2.5 py-1.5 font-mono ${
          onDark ? 'bg-white/15 text-glow-200' : 'bg-pine-800 text-pine-50 dark:bg-pine-300 dark:text-pine-950'
        }`}
      >
        {n ? `Window ${n}` : 'Front desk'}
      </span>
      <span
        className={`flex items-center px-2.5 py-1.5 font-sans font-bold ${
          onDark ? 'text-white' : 'text-pine-900 dark:text-pine-100'
        }`}
      >
        {label}
      </span>
    </p>
  );
}

/** Signature strip: alpenglow-to-pine gradient under survey-tape ticks. */
export function RidgeBand({ className = 'h-[5px]' }: { className?: string }) {
  return <div aria-hidden className={`ridge-band ${className}`} />;
}

/**
 * Brass grommet — the punched eyelet of a permit placard posted at the job
 * site. Parent must be `relative`; the hole shows the page ground through it.
 */
export function Grommet() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute left-1/2 top-2 size-3 -translate-x-1/2 rounded-full border-[3.5px] border-brass-400 bg-paper shadow-inner dark:border-brass-600 dark:bg-stone-950"
    />
  );
}

/* Category chips — shared by the catalog placards, the Apply picker, and the
   dashboard row tiles, so a permit's category reads the same at every window. */
export const CATEGORY_BADGE: Record<string, string> = {
  Building: 'bg-pine-100 text-pine-800 dark:bg-pine-900/60 dark:text-pine-200',
  Business: 'bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300',
  Events: 'bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-300',
  Housing: 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
};

const CATEGORY_ICON: Record<string, ReactNode> = {
  Building: (
    <>
      <path d="M6 21V8h12v13" />
      <path d="M6 12h12M6 16.5h12" />
      <path d="M9.5 8V5h5v3" />
      <path d="M3 21h18" />
    </>
  ),
  Business: (
    <>
      <path d="M4 9 5.5 4h13L20 9" />
      <path d="M4.5 9v12h15V9" />
      <path d="M9.5 21v-6h5v6" />
    </>
  ),
  Events: (
    <>
      <path d="M5.5 21V4" />
      <path d="M5.5 5h13l-3 4 3 4h-13" />
    </>
  ),
  Housing: (
    <>
      <path d="m3 11.5 9-7.5 9 7.5" />
      <path d="M6 10v11h12V10" />
      <path d="M10 21v-6h4v6" />
    </>
  ),
};

export function CategoryIcon({ category, className = 'size-3.5 shrink-0' }: { category: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {CATEGORY_ICON[category] ?? (
        <>
          <rect x="6" y="4" width="12" height="17" rx="2" />
          <path d="M9 10h6M9 14h4" />
        </>
      )}
    </svg>
  );
}

export function CategoryBadge({ category }: { category: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 self-start rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${
        CATEGORY_BADGE[category] ?? 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300'
      }`}
    >
      <CategoryIcon category={category} />
      {category}
    </span>
  );
}

/** Square icon tile for list rows — the category chip's bigger sibling. */
export function CategoryTile({ category }: { category: string }) {
  return (
    <span
      className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${
        CATEGORY_BADGE[category] ?? 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300'
      }`}
    >
      <CategoryIcon category={category} className="size-5" />
    </span>
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

/* Status reads as the reviewer's stamp on the application: square-cornered,
   mono, letterspaced, bordered like an ink stamp rather than a web pill. */
const STATUS_STYLES: Record<AppStatus, string> = {
  submitted:
    'bg-stone-100 text-stone-700 border-stone-400/70 dark:bg-stone-800 dark:text-stone-300 dark:border-stone-500',
  under_review:
    'bg-amber-50 text-amber-800 border-amber-500/60 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-700',
  approved:
    'bg-emerald-50 text-emerald-800 border-emerald-600/50 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-700',
  denied:
    'bg-rose-50 text-rose-800 border-rose-500/60 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-700',
};

export function StatusChip({ status }: { status: AppStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-[4px] border px-2 py-[3px] font-mono text-[10.5px] font-medium uppercase leading-none tracking-[0.12em] ${STATUS_STYLES[status]}`}
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
    <Card className="overflow-hidden">
      <RidgeBand className="h-[3px]" />
      <div className="px-5 pb-4 pt-3.5">
        <p className="font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-stone-500 dark:text-stone-400">
          {label}
        </p>
        <p className="mt-1.5 font-mono text-[1.75rem] font-medium leading-none text-pine-900 dark:text-pine-100">
          {value}
        </p>
        {sub && <p className="mt-1.5 text-xs text-stone-500 dark:text-stone-400">{sub}</p>}
      </div>
    </Card>
  );
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
