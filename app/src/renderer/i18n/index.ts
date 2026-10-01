import type { UiLang } from '@shared/api';
import { ar, type Dict, type TKey } from './ar';
import { en } from './en';

export type { TKey };

const dictionaries: Record<UiLang, Dict> = { ar: ar as Dict, en };

export type Params = Record<string, string | number>;

/** Pure translate function (usable outside React, e.g. from the store for toasts). */
export function translate(lang: UiLang, key: TKey, params?: Params): string {
  const raw = dictionaries[lang][key] ?? dictionaries.ar[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}

export const dirOf = (lang: UiLang): 'rtl' | 'ltr' => (lang === 'ar' ? 'rtl' : 'ltr');
