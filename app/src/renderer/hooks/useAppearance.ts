import { useEffect, useState } from 'react';
import type { Settings } from '@shared/api';
import { dirOf } from '../i18n';

export type ResolvedTheme = 'dark' | 'light';
const CACHE_KEY = 'rico.ui';

/** Tiny pre-paint cache so reloads do not flash the wrong theme / direction. */
export function readUiCache(): Partial<Pick<Settings, 'theme' | 'uiLang' | 'fontScale'>> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Partial<Settings>) : {};
  } catch {
    return {};
  }
}

function writeUiCache(v: Pick<Settings, 'theme' | 'uiLang' | 'fontScale'>) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable — cosmetic only */
  }
}

const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)');

export function resolveTheme(pref: Settings['theme']): ResolvedTheme {
  if (pref === 'dark' || pref === 'light') return pref;
  return darkQuery().matches ? 'dark' : 'light';
}

/** Apply theme/lang/dir/font to <html> synchronously (used before first render too). */
export function applyAppearance(s: Pick<Settings, 'theme' | 'uiLang' | 'fontScale'>): ResolvedTheme {
  const root = document.documentElement;
  const resolved = resolveTheme(s.theme);
  root.dataset.theme = resolved;
  root.lang = s.uiLang;
  root.dir = dirOf(s.uiLang);
  root.style.setProperty('--font-scale', String(s.fontScale));
  return resolved;
}

// Optional title-bar theming: the preload may expose any of these. Feature-detected, never required.
type MaybeThemeFn = (theme: ResolvedTheme) => unknown;
interface TitleBarCapable {
  window?: { setTheme?: MaybeThemeFn; setTitleBarTheme?: MaybeThemeFn };
  titleBar?: { setTheme?: MaybeThemeFn };
  theme?: { set?: MaybeThemeFn };
  setTitleBarTheme?: MaybeThemeFn;
  setTheme?: MaybeThemeFn;
}

function notifyTitleBar(theme: ResolvedTheme) {
  const r = window.rico as unknown as TitleBarCapable | undefined;
  if (!r) return;
  const fn =
    r.window?.setTitleBarTheme ?? r.window?.setTheme ?? r.titleBar?.setTheme ?? r.theme?.set ?? r.setTitleBarTheme ?? r.setTheme;
  if (typeof fn !== 'function') return;
  try {
    const res = fn(theme);
    if (res instanceof Promise) res.catch(() => undefined);
  } catch {
    /* ignore — purely cosmetic */
  }
}

/**
 * Keeps <html> in sync with settings: data-theme (incl. live OS changes when "system"),
 * lang/dir, font scale. Returns the resolved theme.
 */
export function useAppearance(settings: Pick<Settings, 'theme' | 'uiLang' | 'fontScale'>): ResolvedTheme {
  const { theme, uiLang, fontScale } = settings;
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(theme));

  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const next = applyAppearance({ theme, uiLang, fontScale });
      setResolved(next);
      notifyTitleBar(next);
    };

    // smooth 200ms cross-fade, only while the theme actually changes
    if (root.dataset.theme && root.dataset.theme !== resolveTheme(theme)) {
      root.classList.add('theme-anim');
      window.setTimeout(() => root.classList.remove('theme-anim'), 320);
    }
    apply();
    writeUiCache({ theme, uiLang, fontScale });

    if (theme !== 'system') return;
    const mq = darkQuery();
    const onChange = () => {
      root.classList.add('theme-anim');
      window.setTimeout(() => root.classList.remove('theme-anim'), 320);
      apply();
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme, uiLang, fontScale]);

  return resolved;
}
