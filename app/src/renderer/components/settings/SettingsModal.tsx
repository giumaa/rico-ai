import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Boxes, Database, Info, Palette, SlidersHorizontal } from 'lucide-react';
import { useActions, useAppState } from '../../store/AppProvider';
import { useI18n } from '../../i18n/useI18n';
import type { TKey } from '../../i18n';
import type { SettingsTab } from '../../store/types';
import { Modal } from '../ui/Modal';
import { ModelsPanel } from '../models/ModelsPanel';
import { AboutTab } from './AboutTab';
import { DataTab } from './DataTab';
import { GeneralTab } from './GeneralTab';
import { PerformanceTab } from './PerformanceTab';

const TABS: { id: SettingsTab; icon: ReactNode; label: TKey }[] = [
  { id: 'general', icon: <Palette aria-hidden />, label: 'settings.tab.general' },
  { id: 'performance', icon: <SlidersHorizontal aria-hidden />, label: 'settings.tab.performance' },
  { id: 'models', icon: <Boxes aria-hidden />, label: 'settings.tab.models' },
  { id: 'data', icon: <Database aria-hidden />, label: 'settings.tab.data' },
  { id: 'about', icon: <Info aria-hidden />, label: 'settings.tab.about' },
];

/** Index of the tab to focus for a navigation key, or null if the key is not a navigation key. */
function nextTabIndex(key: string, current: number, rtl: boolean): number | null {
  const n = TABS.length;
  switch (key) {
    case 'ArrowDown':
      return (current + 1) % n;
    case 'ArrowUp':
      return (current - 1 + n) % n;
    case 'ArrowRight':
      return (current + (rtl ? -1 : 1) + n) % n;
    case 'ArrowLeft':
      return (current + (rtl ? 1 : -1) + n) % n;
    case 'Home':
      return 0;
    case 'End':
      return n - 1;
    default:
      return null;
  }
}

export function SettingsModal() {
  const { t } = useI18n();
  const { modal } = useAppState();
  const { closeModal } = useActions();
  const [tab, setTab] = useState<SettingsTab>(modal?.type === 'settings' ? modal.tab : 'general');

  // allow "open Settings → Models" while the modal is already open
  useEffect(() => {
    if (modal?.type === 'settings') setTab(modal.tab);
  }, [modal]);

  if (modal?.type !== 'settings') return null;

  const onTabsKey = (e: KeyboardEvent) => {
    const rtl = getComputedStyle(e.currentTarget as Element).direction === 'rtl';
    const idx = nextTabIndex(e.key, TABS.findIndex((x) => x.id === tab), rtl);
    if (idx === null) return;
    e.preventDefault();
    const next = TABS[idx];
    if (!next) return;
    setTab(next.id);
    requestAnimationFrame(() => document.getElementById(`settings-tab-${next.id}`)?.focus());
  };

  return (
    <Modal title={t('settings.title')} size="lg" bare onClose={closeModal}>
      <div className="set">
        <div className="set-nav" role="tablist" aria-orientation="vertical" aria-label={t('settings.title')} onKeyDown={onTabsKey}>
          {TABS.map((x) => (
            <button
              key={x.id}
              id={`settings-tab-${x.id}`}
              type="button"
              role="tab"
              className="set-tab"
              aria-selected={tab === x.id}
              aria-controls="settings-panel"
              tabIndex={tab === x.id ? 0 : -1}
              onClick={() => setTab(x.id)}
            >
              {x.icon}
              {t(x.label)}
            </button>
          ))}
        </div>
        <div className="set-panel" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>
          {tab === 'general' && <GeneralTab />}
          {tab === 'performance' && <PerformanceTab />}
          {tab === 'models' && <ModelsPanel variant="settings" />}
          {tab === 'data' && <DataTab />}
          {tab === 'about' && <AboutTab />}
        </div>
      </div>
    </Modal>
  );
}
