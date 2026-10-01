import { Monitor, Moon, Sun } from 'lucide-react';
import type { Settings } from '@shared/api';
import { useActions, useAppState } from '../../store/AppProvider';
import { useI18n } from '../../i18n/useI18n';
import { Segmented } from '../ui/Segmented';
import { Slider } from '../ui/Slider';
import { SettingRow } from './SettingRow';

export function GeneralTab() {
  const { t } = useI18n();
  const { settings } = useAppState();
  const a = useActions();

  return (
    <>
      <section className="set-group">
        <h3 className="set-group-title">{t('settings.group.look')}</h3>

        <SettingRow label={t('settings.theme')} description={t('settings.theme.desc')}>
          <Segmented<Settings['theme']>
            label={t('settings.theme')}
            value={settings.theme}
            onChange={(theme) => a.updateSettings({ theme })}
            options={[
              { value: 'system', label: t('settings.theme.system'), icon: <Monitor aria-hidden /> },
              { value: 'dark', label: t('settings.theme.dark'), icon: <Moon aria-hidden /> },
              { value: 'light', label: t('settings.theme.light'), icon: <Sun aria-hidden /> },
            ]}
          />
        </SettingRow>

        <SettingRow label={t('settings.lang')} description={t('settings.lang.desc')}>
          <Segmented<Settings['uiLang']>
            label={t('settings.lang')}
            value={settings.uiLang}
            onChange={(uiLang) => a.updateSettings({ uiLang })}
            options={[
              { value: 'ar', label: 'العربية' },
              { value: 'en', label: 'English' },
            ]}
          />
        </SettingRow>

        <SettingRow label={t('settings.fontSize')} description={t('settings.fontSize.desc')} stack>
          <div className="set-slider">
            <Slider
              label={t('settings.fontSize')}
              min={0.85}
              max={1.4}
              step={0.05}
              value={settings.fontScale}
              onInput={(fontScale) => a.previewSettings({ fontScale })}
              onCommit={(fontScale) => a.updateSettings({ fontScale })}
            />
            <span className="set-value">{Math.round(settings.fontScale * 100)}%</span>
          </div>
          <p className="font-preview" dir="auto">
            {t('settings.fontSize.sample')}
          </p>
        </SettingRow>
      </section>

      <section className="set-group">
        <h3 className="set-group-title">{t('settings.group.behavior')}</h3>
        <SettingRow label={t('settings.dialect')} description={t('settings.dialect.desc')}>
          <Segmented<Settings['dialect']>
            label={t('settings.dialect')}
            value={settings.dialect}
            onChange={(dialect) => a.updateSettings({ dialect })}
            options={[
              { value: 'libyan', label: t('settings.dialect.libyan') },
              { value: 'msa', label: t('settings.dialect.msa') },
              { value: 'auto', label: t('settings.dialect.auto') },
            ]}
          />
        </SettingRow>
      </section>
    </>
  );
}
