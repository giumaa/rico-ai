import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ImagePlus } from 'lucide-react';
import { AppProvider, useActions, useAppState } from './store/AppProvider';
import { useAppearance } from './hooks/useAppearance';
import { useHotkeys, type Hotkey } from './hooks/useHotkeys';
import { Sidebar, SEARCH_ID } from './components/sidebar/Sidebar';
import { Header } from './components/chat/Header';
import { ChatView } from './components/chat/ChatView';
import { Composer, COMPOSER_ID } from './components/composer/Composer';
import { SettingsModal } from './components/settings/SettingsModal';
import { Onboarding } from './components/models/Onboarding';
import { Toaster } from './components/toasts/Toaster';
import { Logo } from './components/brand/Logo';
import { useI18n } from './i18n/useI18n';
import { visionBlocked } from './store/selectors';

const NARROW = '(max-width: 880px)';

function Shell() {
  const state = useAppState();
  const a = useActions();
  const theme = useAppearance(state.settings);
  const { t } = useI18n();

  // ---- drag & drop images anywhere on the chat
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const onDragEnter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current++;
    setDragging(true);
  };
  const onDragOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = visionBlocked(state) ? 'none' : 'copy';
  };
  const onDragLeave = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void a.addImages(Array.from(e.dataTransfer.files));
  };
  // a file dropped outside the chat must never navigate the window
  useEffect(() => {
    const stop = (e: globalThis.DragEvent) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, []);

  // sidebar: open on wide windows, drawer (closed) on narrow ones — follows window resizes
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    a.setSidebar(!mq.matches);
    const onChange = (e: MediaQueryListEvent) => a.setSidebar(!e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hotkeys = useMemo<Hotkey[]>(
    () => [
      {
        key: 'n',
        mod: true,
        run: () => {
          a.newChat();
          document.getElementById(COMPOSER_ID)?.focus();
        },
      },
      {
        key: 'k',
        mod: true,
        run: () => {
          a.setSidebar(true);
          requestAnimationFrame(() => document.getElementById(SEARCH_ID)?.focus());
        },
      },
      { key: 'b', mod: true, run: () => a.toggleSidebar() },
      { key: ',', mod: true, run: () => a.openSettings('general') },
    ],
    [a],
  );
  useHotkeys(hotkeys);

  return (
    <>
      <div className="app" data-sidebar={state.sidebarOpen ? 'open' : 'closed'} inert={state.onboarding}>
        <div className="app-bg" aria-hidden="true" />
        <Sidebar />
        <div className="sb-scrim" onClick={() => a.setSidebar(false)} aria-hidden="true" />
        <main
          className="main"
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          <Header theme={theme} />
          <ChatView />
          <Composer />
          {dragging ? (
            <div className="drop-overlay" aria-hidden="true">
              <ImagePlus />
              <span>{t('composer.dropImages')}</span>
            </div>
          ) : null}
        </main>
      </div>

      <SettingsModal />
      {state.booted && state.onboarding ? <Onboarding /> : null}
      <Toaster />
      {!state.booted ? (
        <div className="splash" aria-hidden="true">
          <Logo size={84} />
        </div>
      ) : null}
    </>
  );
}

export function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
