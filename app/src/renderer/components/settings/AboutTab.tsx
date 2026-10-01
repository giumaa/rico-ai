import { ShieldCheck } from 'lucide-react';
import { useAppState } from '../../store/AppProvider';
import { useI18n } from '../../i18n/useI18n';
import type { TKey } from '../../i18n';
import { Logo } from '../brand/Logo';

const PROMISES: TKey[] = ['onb.promise1', 'onb.promise2', 'onb.promise3', 'onb.promise4'];

export function AboutTab() {
  const { t, lang } = useI18n();
  const { system } = useAppState();
  return (
    <div className="about">
      <Logo size={96} />
      <div className="about-name">{t('app.name')}</div>
      <div className="about-latin" dir="ltr">
        Rico
      </div>
      <div className="set-label">{t('about.developedBy')}</div>
      <div className="about-meta" dir={lang === 'ar' ? 'ltr' : 'rtl'}>
        {t('about.developedByLatin')}
      </div>
      <div className="about-meta">{t('about.version', { version: system?.appVersion ?? '—' })}</div>
      <span className="badge badge-green">
        <ShieldCheck aria-hidden />
        {t('about.offline')}
      </span>

      <ul className="about-list">
        {PROMISES.map((k) => (
          <li key={k}>
            <ShieldCheck aria-hidden />
            {t(k)}
          </li>
        ))}
      </ul>
      <p className="about-fonts">{t('about.fonts')}</p>
    </div>
  );
}
