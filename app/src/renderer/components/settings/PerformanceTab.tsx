import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Gauge, Leaf, Rocket, ShieldCheck } from 'lucide-react';
import type { PerfMode } from '@shared/api';
import { useActions, useAppState } from '../../store/AppProvider';
import { useI18n } from '../../i18n/useI18n';
import type { TKey } from '../../i18n';
import { Slider } from '../ui/Slider';
import { SettingRow } from './SettingRow';

const MODES: { value: PerfMode; icon: ReactNode; title: TKey; desc: TKey }[] = [
  { value: 'eco', icon: <Leaf aria-hidden />, title: 'settings.perf.eco', desc: 'settings.perf.eco.desc' },
  { value: 'balanced', icon: <Gauge aria-hidden />, title: 'settings.perf.balanced', desc: 'settings.perf.balanced.desc' },
  { value: 'max', icon: <Rocket aria-hidden />, title: 'settings.perf.max', desc: 'settings.perf.max.desc' },
];

export function PerformanceTab() {
  const { t } = useI18n();
  const { settings } = useAppState();
  const a = useActions();
  const groupRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const rtl = getComputedStyle(e.currentTarget as Element).direction === 'rtl';
    const forward = e.key === 'ArrowDown' || e.key === (rtl ? 'ArrowLeft' : 'ArrowRight');
    const i = MODES.findIndex((m) => m.value === settings.perfMode);
    const next = MODES[(i + (forward ? 1 : -1) + MODES.length) % MODES.length];
    if (!next) return;
    a.updateSettings({ perfMode: next.value });
    requestAnimationFrame(() => groupRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
  };

  return (
    <>
      <section className="set-group">
        <SettingRow label={t('settings.perf')} stack>
          <div ref={groupRef} className="perf-grid" role="radiogroup" aria-label={t('settings.perf')} onKeyDown={onKeyDown}>
            {MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                role="radio"
                className="perf-card"
                aria-checked={settings.perfMode === m.value}
                tabIndex={settings.perfMode === m.value ? 0 : -1}
                onClick={() => a.updateSettings({ perfMode: m.value })}
              >
                <span className="perf-card-head">
                  {m.icon}
                  {t(m.title)}
                </span>
                <p>{t(m.desc)}</p>
              </button>
            ))}
          </div>
          <p className="perf-note">
            <ShieldCheck aria-hidden />
            <span>{t('settings.perf.note')}</span>
          </p>
        </SettingRow>
      </section>

      <section className="set-group">
        <SettingRow label={t('settings.temperature')} description={t('settings.temperature.desc')} stack>
          <div className="set-slider">
            <Slider
              label={t('settings.temperature')}
              min={0}
              max={1.5}
              step={0.05}
              value={settings.temperature}
              onInput={(temperature) => a.previewSettings({ temperature })}
              onCommit={(temperature) => a.updateSettings({ temperature })}
            />
            <span className="set-value">{settings.temperature.toFixed(2)}</span>
          </div>
          <div className="set-slider-ends">
            <span>{t('settings.temperature.low')}</span>
            <span>{t('settings.temperature.high')}</span>
          </div>
        </SettingRow>

        <SettingRow label={t('settings.maxTokens')} description={t('settings.maxTokens.desc')} stack>
          <div className="set-slider">
            <Slider
              label={t('settings.maxTokens')}
              min={128}
              max={4096}
              step={64}
              value={settings.maxTokens}
              onInput={(maxTokens) => a.previewSettings({ maxTokens })}
              onCommit={(maxTokens) => a.updateSettings({ maxTokens })}
            />
            <span className="set-value">{settings.maxTokens}</span>
          </div>
          <div className="set-slider-ends">
            <span>{t('settings.maxTokens.short')}</span>
            <span>{t('settings.maxTokens.long')}</span>
          </div>
        </SettingRow>
      </section>
    </>
  );
}
