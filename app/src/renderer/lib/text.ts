// Text helpers: script detection (for per-message line-height), titles, ids.

const ARABIC_LETTER = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFC]/g;
const LATIN_LETTER = /[A-Za-z\u00C0-\u024F]/g;

export type Script = 'ar' | 'latin';

/**
 * Which script dominates a text. Used only to pick a comfortable line-height
 * (Arabic ruqaa needs ~1.95, Latin ~1.75). Direction itself is handled by the
 * browser through dir="auto" on every block.
 */
export function scriptOf(text: string): Script {
  const sample = text.length > 1200 ? text.slice(0, 1200) : text;
  const ar = sample.match(ARABIC_LETTER)?.length ?? 0;
  const la = sample.match(LATIN_LETTER)?.length ?? 0;
  return ar >= la * 0.4 && ar > 0 ? 'ar' : la > 0 ? 'latin' : 'ar';
}

/** First ~40 characters of the first user message, cut on a word boundary. */
export function makeTitle(text: string, max = 40): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  if (flat.length <= max) return flat;
  const slice = flat.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > max * 0.55 ? slice.slice(0, lastSpace) : slice;
  return `${cut.replace(/[\s.,،؛:!?؟-]+$/u, '')}…`;
}

export function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Pull plain text out of a React node tree (used by the code block copy button). */
export function nodeToText(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join('');
  if (typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { children?: unknown } }).props;
    return nodeToText(props?.children);
  }
  return '';
}

const STRONG_RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC]/;
const STRONG_LTR = /[A-Za-z\u00C0-\u024F\u0370-\u052F]/;

/**
 * Direction of the first strong character (what dir="auto" does), but computable for container
 * elements whose children carry their own dir attribute (the browser skips those when resolving
 * dir="auto", so a list or blockquote full of Arabic paragraphs would wrongly resolve to LTR).
 */
export function detectDir(text: string): 'rtl' | 'ltr' | undefined {
  const sample = text.length > 400 ? text.slice(0, 400) : text;
  for (const ch of sample) {
    if (STRONG_RTL.test(ch)) return 'rtl';
    if (STRONG_LTR.test(ch)) return 'ltr';
  }
  return undefined;
}
