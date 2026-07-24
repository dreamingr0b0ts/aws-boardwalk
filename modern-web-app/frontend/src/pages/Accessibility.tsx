import { useLang } from '../lib/i18n';
import { Card, WindowPlate } from '../components/Ui';

// The accessibility statement: WCAG 2.1 AA is the bar Colorado's HB21-1110
// sets for government web services, so a permitting demo aimed at Colorado
// buyers states its conformance the way a real one would.

export default function Accessibility() {
  const { t } = useLang();
  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <WindowPlate label={t('a11y.title')} />
      <h1 className="mt-3 font-display text-2xl font-bold text-pine-950 dark:text-pine-100">{t('a11y.h1')}</h1>
      <p className="mt-3 text-[15px] leading-relaxed text-stone-700 dark:text-stone-300">{t('a11y.intro')}</p>

      <Card className="mt-6 p-6">
        <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-stone-500 dark:text-stone-400">
          {t('a11y.measuresH')}
        </h2>
        <ul className="mt-4 space-y-3 text-sm leading-relaxed text-stone-700 dark:text-stone-300">
          {(['a11y.m1', 'a11y.m2', 'a11y.m3', 'a11y.m4', 'a11y.m5'] as const).map((key) => (
            <li key={key} className="flex gap-3">
              <span aria-hidden className="mt-1.5 size-2 shrink-0 rotate-45 rounded-[2px] bg-pine-500" />
              <span>{t(key)}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="mt-4 p-6">
        <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-stone-500 dark:text-stone-400">
          {t('a11y.testingH')}
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-stone-700 dark:text-stone-300">{t('a11y.testing')}</p>
      </Card>

      <Card className="mt-4 p-6">
        <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-stone-500 dark:text-stone-400">
          {t('a11y.feedbackH')}
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-stone-700 dark:text-stone-300">{t('a11y.feedback')}</p>
      </Card>

      <p className="mt-5 text-xs leading-relaxed text-stone-500 dark:text-stone-400">{t('a11y.note')}</p>
    </div>
  );
}
