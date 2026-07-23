import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { RidgeBand } from './Ui';

export function Mountain({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <defs>
        <linearGradient id="nav-glow" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ee7351" />
          <stop offset="1" stopColor="#c4401f" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="#16302e" />
      <path d="M8 46 22 22l8 12 6-8 12 20z" fill="url(#nav-glow)" />
      <path d="M22 22l5 7-3 4-8 13H8z" fill="#f59e83" opacity=".55" />
      <circle cx="48" cy="16" r="5" fill="#fde5dc" />
    </svg>
  );
}

function ThemeToggle() {
  const { dark, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={dark ? 'Light mode' : 'Dark mode'}
      className="flex size-9 items-center justify-center rounded-lg border border-stone-300 text-stone-500 transition-colors hover:border-pine-400 hover:text-pine-800 dark:border-stone-600 dark:text-stone-400 dark:hover:border-pine-400 dark:hover:text-pine-200"
    >
      {dark ? (
        <svg viewBox="0 0 24 24" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
        </svg>
      )}
    </button>
  );
}

const navLink = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
    isActive
      ? 'bg-pine-50 text-pine-900 dark:bg-pine-900/50 dark:text-pine-100'
      : 'text-stone-600 hover:text-pine-800 dark:text-stone-400 dark:hover:text-pine-200'
  }`;

export default function Layout() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="flex min-h-screen flex-col">
      <div className="bg-pine-950 px-4 py-1.5 text-center text-xs text-pine-100">
        Fictional demonstration environment. The City of Alpenglow is not a real municipality. Demo data resets
        nightly.
      </div>

      <header className="sticky top-0 z-40 border-b border-stone-200 bg-white/95 backdrop-blur dark:border-stone-800 dark:bg-stone-950/95">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link to="/" className="flex items-center gap-2.5">
            <Mountain className="size-9" />
            <span className="leading-tight">
              <span className="block font-display text-base font-bold text-pine-900 dark:text-pine-100">Alpenglow Permits</span>
              <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-stone-500 dark:text-stone-400">
                City of Alpenglow, CO · Elev 8,750 ft · Demo
              </span>
            </span>
          </Link>

          <nav className="flex flex-1 flex-wrap items-center gap-1">
            <NavLink to="/" end className={navLink}>
              Permits
            </NavLink>
            <NavLink to="/stats" className={navLink}>
              Transparency
            </NavLink>
            {user && (
              <NavLink to="/dashboard" className={navLink}>
                My applications
              </NavLink>
            )}
            {user?.isAdmin && (
              <NavLink to="/admin" className={navLink}>
                Staff
              </NavLink>
            )}
          </nav>

          <div className="flex items-center gap-3">
            <ThemeToggle />
            {user ? (
              <>
                <span className="hidden text-right sm:block">
                  <span className="block text-sm font-semibold text-stone-700 dark:text-stone-300">{user.name}</span>
                  <span
                    className={`block text-[11px] font-semibold uppercase tracking-wide ${
                      user.isAdmin ? 'text-glow-600 dark:text-glow-400' : 'text-pine-600 dark:text-pine-300'
                    }`}
                  >
                    {user.isAdmin ? 'Staff · admin' : 'Resident'}
                  </span>
                </span>
                <button
                  onClick={() => {
                    void signOut().then(() => navigate('/'));
                  }}
                  className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-semibold text-stone-600 hover:border-pine-400 hover:text-pine-800 dark:border-stone-600 dark:text-stone-300 dark:hover:border-pine-400 dark:hover:text-pine-200"
                >
                  Sign out
                </button>
              </>
            ) : (
              <Link
                to="/login"
                className="rounded-lg bg-pine-800 px-4 py-1.5 text-sm font-semibold text-white hover:bg-pine-700 dark:bg-pine-600 dark:hover:bg-pine-500"
              >
                Sign in
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="mt-16 bg-pine-950 text-pine-100">
        <RidgeBand />
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-3">
          <div>
            <div className="flex items-center gap-2">
              <Mountain className="size-7" />
              <span className="font-display font-bold text-white">Alpenglow Permits</span>
            </div>
            <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-pine-300">
              Town Hall counter · Windows 01 to 05 · Elev 8,750 ft
            </p>
            <p className="mt-3 text-xs leading-relaxed text-pine-200">
              A demonstration of a production-patterned serverless web application: static delivery, real
              authentication, role-based access, and a live data tier, idling at ~$0.
            </p>
          </div>
          <div className="text-sm">
            <p className="font-semibold text-white">Environment</p>
            <ul className="mt-2 space-y-1 text-pine-200">
              <li>AWS: S3 · CloudFront · Cognito · API Gateway · Lambda · DynamoDB</li>
              <li>Infrastructure as code: Terraform</li>
              <li>Demo data reseeds nightly at 3am MT</li>
              <li>Photography: Unsplash (Daniel Ribar, Alex Moliski, Royce Fonseca)</li>
            </ul>
          </div>
          <div className="text-sm">
            <p className="font-semibold text-white">Planetek</p>
            <ul className="mt-2 space-y-1">
              <li>
                <a
                  className="text-pine-200 underline-offset-2 hover:text-white hover:underline"
                  href="https://github.com/dreamingr0b0ts/aws-boardwalk"
                >
                  Github
                </a>
              </li>
              <li>
                <a className="text-pine-200 underline-offset-2 hover:text-white hover:underline" href="https://planetek.org">
                  planetek.org
                </a>
              </li>
              <li>
                <a
                  className="text-pine-200 underline-offset-2 hover:text-white hover:underline"
                  href="https://demos.planetek.org"
                >
                  More live environments
                </a>
              </li>
            </ul>
          </div>
        </div>
        <div className="border-t border-pine-800 px-4 py-4 text-center text-xs text-pine-300">
          Fictional demo built by Planetek. Not affiliated with any real government agency.
        </div>
      </footer>
    </div>
  );
}
