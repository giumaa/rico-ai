import { EyeOff, Lock, Sparkles, WifiOff } from 'lucide-react';
import { useI18n } from '../../i18n/useI18n';
import type { TKey } from '../../i18n';
import { Logo } from '../brand/Logo';

const SUGGESTIONS: TKey[] = ['hero.s1', 'hero.s2', 'hero.s3', 'hero.s4'];

interface HeroProps {
  onPick: (text: string) => void;
}

/** Empty state: mark with a saffron→ember aura, greeting, 4 suggestion chips (Libyan dialect). */
export function Hero({ onPick }: HeroProps) {
  const { t, rich } = useI18n();
  return (
    <div className="hero">
      <div className="hero-mark">
        <Logo size={92} />
      </div>
      <h1 className="hero-title">{rich('hero.title')}</h1>
      <p className="hero-sub">{t('hero.subtitle')}</p>

      <div className="hero-chips" role="list">
        {SUGGESTIONS.map((key) => (
          <button
            key={key}
            type="button"
            role="listitem"
            className="chip"
            dir="auto"
            onClick={() => onPick(t(key))}
          >
            <Sparkles aria-hidden />
            <span>{t(key)}</span>
          </button>
        ))}
      </div>

      <div className="hero-privacy" aria-label={t('app.tagline')}>
        <span>
          <WifiOff aria-hidden />
          {t('onb.promise1')}
        </span>
        <span>
          <Lock aria-hidden />
          {t('onb.promise2')}
        </span>
        <span>
          <EyeOff aria-hidden />
          {t('onb.promise3')}
        </span>
      </div>
    </div>
  );
}
