import { useEffect } from 'react';

export interface Hotkey {
  /** event.key, case-insensitive (e.g. 'n', 'k', 'b', ',') */
  key: string;
  /** Ctrl on Windows/Linux, Cmd on macOS */
  mod?: boolean;
  shift?: boolean;
  run: (e: KeyboardEvent) => void;
}

/** Global keyboard shortcuts. Handlers are kept fresh without re-subscribing. */
export function useHotkeys(keys: Hotkey[]) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      for (const k of keys) {
        if (k.key.toLowerCase() !== e.key.toLowerCase()) continue;
        if (!!k.mod !== mod) continue;
        if (!!k.shift !== e.shiftKey) continue;
        e.preventDefault();
        k.run(e);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keys]);
}
