import { Moon, PanelLeftOpen, Settings, Sun } from 'lucide-react';
import { useActions, useAppState } from '../../store/AppProvider';
import { useI18n } from '../../i18n/useI18n';
import { MOD_LABEL } from '../../lib/platform';
import { Logo } from '../brand/Logo';
import { IconButton } from '../ui/IconButton';
import type { ResolvedTheme } from '../../hooks/useAppearance';

interface HeaderProps {
  theme: ResolvedTheme;
}

export function Header({ theme }: HeaderProps) {
  const { t, lang } = useI18n();
  const { sidebarOpen, activeChatId, chats, chatIndex, models, loadState } = useAppState();
  const a = useActions();

  const chat = activeChatId ? chatIndex.find((c) => c.id === activeChatId) ?? chats[activeChatId] : undefined;
  const hasInstalled = models.some((m) => m.status === 'installed');
  const active =
    models.find((m) => m.isActive) ?? models.find((m) => m.id === loadState.modelId && m.status === 'installed');

  let label: string;
  let state: 'ready' | 'loading' | 'idle' | 'error' = loadState.state;
  if (loadState.state === 'loading') label = t('model.loading');
  else if (!hasInstalled) {
    label = t('model.none');
    state = 'idle';
  } else if (loadState.state === 'error') label = t('model.error');
  else label = active ? active.name[lang] : t('model.idle');

  return (
    <header className="main-header drag">
      {!sidebarOpen ? (
        <>
          <IconButton label={`${t('sidebar.expand')} (${MOD_LABEL} B)`} onClick={() => a.setSidebar(true)}>
            <PanelLeftOpen className="flip-rtl" aria-hidden />
          </IconButton>
          <div className="header-brand">
            <Logo size={28} />
          </div>
        </>
      ) : null}

      <div className="main-title" dir="auto" title={chat?.title}>
        {chat?.title ?? ''}
      </div>

      <button
        type="button"
        className="model-pill no-drag"
        onClick={() => (hasInstalled ? a.openSettings('models') : a.openModelScreen())}
        title={loadState.error ?? label}
      >
        <span className="status-dot" data-state={state} aria-hidden="true" />
        <span className="model-pill-label" dir="auto">
          {label}
        </span>
      </button>

      <IconButton
        label={theme === 'dark' ? t('header.theme.toLight') : t('header.theme.toDark')}
        onClick={() => a.updateSettings({ theme: theme === 'dark' ? 'light' : 'dark' })}
      >
        {theme === 'dark' ? <Sun aria-hidden /> : <Moon aria-hidden />}
      </IconButton>
      <IconButton label={`${t('sidebar.settings')} (${MOD_LABEL} ,)`} onClick={() => a.openSettings('general')}>
        <Settings aria-hidden />
      </IconButton>
    </header>
  );
}
