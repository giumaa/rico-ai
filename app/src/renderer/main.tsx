import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { App } from './App';
import { applyAppearance, readUiCache } from './hooks/useAppearance';

async function start() {
  // paint the right theme / direction / font size from the very first frame
  const cached = readUiCache();
  applyAppearance({
    theme: cached.theme ?? 'system',
    uiLang: cached.uiLang ?? 'ar',
    fontScale: cached.fontScale ?? 1,
  });

  // lets CSS reserve room for the native title-bar controls (see --tb-left / --tb-right)
  const nav = navigator.platform || navigator.userAgent;
  document.documentElement.dataset.platform = /Mac/i.test(nav) ? 'mac' : /Win/i.test(nav) ? 'win' : 'other';

  // Not inside Electron (plain `vite` in a browser)? Install the in-memory fake bridge.
  if (typeof window.rico === 'undefined') {
    const { installMockRico } = await import('./dev/mockRico');
    installMockRico();
  }

  const container = document.getElementById('root');
  if (!container) throw new Error('#root not found');
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
