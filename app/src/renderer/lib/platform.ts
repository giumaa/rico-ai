const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

/** Label of the primary modifier key for shortcut hints. */
export const MOD_LABEL = isMac ? '⌘' : 'Ctrl';
