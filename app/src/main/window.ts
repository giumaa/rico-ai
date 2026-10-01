// Main window creation + theme-aware native chrome (Windows title-bar overlay, macOS inset traffic lights).

import { BrowserWindow, nativeTheme } from 'electron';
import type { ThemePref } from '../shared/api';
import { iconPath, isDev, preloadPath } from './paths';

export type ResolvedTheme = 'dark' | 'light';

// Matches the "Libyan desert night" palette in SPEC.md.
const CHROME: Record<ResolvedTheme, { bg: string; fg: string }> = {
  dark: { bg: '#0F0D0B', fg: '#F3ECE2' },
  light: { bg: '#F7F1E6', fg: '#1C1714' }
};
export const TITLEBAR_HEIGHT = 40;

export function resolveTheme(pref: ThemePref): ResolvedTheme {
  nativeTheme.themeSource = pref;
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

export function applyTitleBarTheme(win: BrowserWindow, theme: ResolvedTheme): void {
  const c = CHROME[theme];
  try {
    win.setBackgroundColor(c.bg);
  } catch {
    /* window may be closing */
  }
  if (process.platform === 'win32' || process.platform === 'linux') {
    try {
      win.setTitleBarOverlay({ color: c.bg, symbolColor: c.fg, height: TITLEBAR_HEIGHT });
    } catch {
      /* not supported on this window configuration */
    }
  }
}

export interface CreateWindowOptions {
  theme: ResolvedTheme;
  startUrl: string;
}

export function createMainWindow(opts: CreateWindowOptions): BrowserWindow {
  const c = CHROME[opts.theme];
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    show: false,
    backgroundColor: c.bg,
    title: 'Rico · ريكو',
    icon: iconPath(),
    autoHideMenuBar: true,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 14 } }
      : process.platform === 'win32'
        ? {
            titleBarStyle: 'hidden' as const,
            titleBarOverlay: { color: c.bg, symbolColor: c.fg, height: TITLEBAR_HEIGHT }
          }
        : {}),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
      webviewTag: false,
      safeDialogs: true,
      navigateOnDragDrop: false,
      devTools: isDev() || process.env.RICO_DEVTOOLS === '1'
    }
  });

  win.once('ready-to-show', () => win.show());

  if (isDev() || process.env.RICO_DEVTOOLS === '1') {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
        win.webContents.toggleDevTools();
      }
    });
  }

  void win.loadURL(opts.startUrl);
  return win;
}
