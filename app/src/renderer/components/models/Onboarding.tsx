import type { ReactElement } from 'react';
import { EyeOff, Lock, ShieldCheck, WifiOff } from 'lucide-react';
import { useActions, useAppState } from '../../store/AppProvider';
import { useI18n } from '../../i18n/useI18n';
import type { TKey } from '../../i18n';
import { Logo } from '../brand/Logo';
import { Segmented } from '../ui/Segmented';
import { ModelsPanel } from './ModelsPanel';

const PROMISES: { key: TKey; icon: ReactElement }[] = [
  { key: 'onb.promise1', icon: <WifiOff aria-hidden /> },
  { key: 'onb.promise2', icon: <Lock aria-hidden /> },
  { key: 'onb.promise3', icon: <EyeOff aria-hidden /> },
  { key: 'onb.promise4', icon: <ShieldCheck aria-hidden /> },
];

/** First-run welcome + model selection (also opened when no model is installed). */
export function Onboarding() {
  const { t, rich, lang } = useI18n();
  const { models, loadState } = useAppState();
  const a = useActions();
  const ready = loadState.state === 'ready' || models.some((m) => m.isActive);

  return (
    <div className="onb" role="dialog" aria-modal="true" aria-label={t('onb.title').replace(/<\/?b>/g, '')}>
      <div className="onb-inner">
        <div className="onb-top">
          <Segmented
            label="Language"
            value={lang}
            onChange={(v) => a.updateSettings({ uiLang: v })}
            options={[
              { value: 'ar', label: 'العربية' },
              { value: 'en', label: 'English' },
            ]}
          />
        </div>

        <section className="onb-hero">
          <div className="hero-mark">
            <Logo size={88} />
          </div>
          <h1 className="onb-title">{rich('onb.title')}</h1>
          <p className="onb-sub">{t('onb.subtitle')}</p>
        </section>

        <ul className="promises">
          {PROMISES.map((p) => (
            <li className="promise" key={p.key}>
              <span className="promise-ico">{p.icon}</span>
              {t(p.key)}
            </li>
          ))}
        </ul>

        <ModelsPanel variant="onboarding" />

        <div className="onb-foot">
          <button type="button" className="btn btn-ghost" onClick={a.closeOnboarding}>
            {t('onb.skip')}
          </button>
          <button type="button" className="btn btn-primary btn-lg" disabled={!ready} onClick={a.closeOnboarding}>
            {t('onb.start')}
          </button>
        </div>
      </div>
    </div>
  );
}
