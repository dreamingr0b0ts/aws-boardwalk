import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { AppNotification, AppStatus } from '../types';
import { STATUS_LABEL } from '../types';
import { fmtDate } from './Ui';

// The counter bell: staff actions on your applications ring here. Unread
// state is server-side (lastReadAt on the user's profile item), so it
// follows the account, not the browser.

const DOT: Record<AppStatus, string> = {
  submitted: 'bg-stone-400',
  under_review: 'bg-amber-500',
  approved: 'bg-emerald-600',
  denied: 'bg-rose-600',
};

export default function NotificationBell() {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [lastReadAt, setLastReadAt] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    void api<{ notifications: AppNotification[]; lastReadAt: string | null }>('/me/notifications', { auth: true })
      .then((r) => {
        setNotifications(r.notifications);
        setLastReadAt(r.lastReadAt);
      })
      .catch(() => undefined);
  }, []);

  useEffect(load, [load]);

  const unread = notifications.filter((n) => !lastReadAt || n.at > lastReadAt).length;

  function markRead() {
    void api<{ lastReadAt: string }>('/me/notifications/read', { method: 'POST', auth: true })
      .then((r) => setLastReadAt(r.lastReadAt))
      .catch(() => undefined);
  }

  return (
    <div className="relative">
      <button
        onClick={() => {
          setOpen((o) => !o);
          if (!open) load();
        }}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        className="relative flex size-9 items-center justify-center rounded-lg border border-stone-300 text-stone-500 transition-colors hover:border-pine-400 hover:text-pine-800 dark:border-stone-600 dark:text-stone-400 dark:hover:border-pine-400 dark:hover:text-pine-200"
      >
        <svg viewBox="0 0 24 24" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 8a6 6 0 0 1 12 0c0 7 2 8 2 8H4s2-1 2-8" />
          <path d="M10.3 20a2 2 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-glow-600 px-1 font-mono text-[10px] font-medium leading-none text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <button aria-label="Close notifications" className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-xl dark:border-stone-700 dark:bg-stone-900">
            <div className="flex items-center justify-between border-b border-stone-100 bg-stone-50 px-4 py-2.5 dark:border-stone-800 dark:bg-stone-950/60">
              <p className="font-mono text-[10.5px] font-medium uppercase tracking-[0.16em] text-stone-500 dark:text-stone-400">
                Counter bell
              </p>
              {unread > 0 && (
                <button onClick={markRead} className="text-xs font-semibold text-pine-700 hover:text-pine-900 dark:text-pine-300 dark:hover:text-pine-100">
                  Mark all read
                </button>
              )}
            </div>
            {notifications.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-stone-400">
                No notices yet. Staff actions on your applications will ring here.
              </p>
            ) : (
              <ul className="max-h-96 divide-y divide-stone-100 overflow-y-auto dark:divide-stone-800">
                {notifications.map((n) => {
                  const isUnread = !lastReadAt || n.at > lastReadAt;
                  return (
                    <li key={`${n.at}-${n.appId}`}>
                      <Link
                        to={`/applications/${n.appId}`}
                        onClick={() => setOpen(false)}
                        className={`block px-4 py-3 hover:bg-pine-50/60 dark:hover:bg-pine-900/20 ${isUnread ? 'bg-glow-50/50 dark:bg-glow-600/5' : ''}`}
                      >
                        <span className="flex items-start gap-2.5">
                          <span className={`mt-1.5 size-2 shrink-0 rotate-45 rounded-[2px] ${DOT[n.status]}`} aria-hidden />
                          <span className="min-w-0">
                            <span className="block text-sm font-semibold leading-snug text-stone-800 dark:text-stone-200">
                              {n.typeName} · {STATUS_LABEL[n.status].toLowerCase()}
                            </span>
                            {n.note && <span className="mt-0.5 block truncate text-xs text-stone-500 dark:text-stone-400">{n.note}</span>}
                            <span className="mt-0.5 block font-mono text-[10.5px] text-stone-400">{fmtDate(n.at)}</span>
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
