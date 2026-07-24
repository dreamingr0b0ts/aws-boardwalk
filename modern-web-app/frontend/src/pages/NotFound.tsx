import { Link } from 'react-router-dom';
import { useLang } from '../lib/i18n';

export default function NotFound() {
  const { t } = useLang();
  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <p className="font-mono text-6xl font-medium text-pine-200 dark:text-pine-800">404</p>
      <div className="mx-auto mt-6 size-3 rotate-45 rounded-[2px] bg-glow-500" aria-hidden />
      <h1 className="mt-4 font-display text-xl font-bold text-pine-950 dark:text-pine-100">{t('nf.title')}</h1>
      <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">{t('nf.body')}</p>
      <Link to="/" className="mt-6 inline-block rounded-lg bg-pine-800 px-4 py-2 text-sm font-bold text-white hover:bg-pine-700">
        {t('nf.cta')}
      </Link>
    </div>
  );
}
