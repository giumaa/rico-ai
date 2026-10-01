import { Fragment, useCallback, useMemo, type ReactNode } from 'react';
import type { UiLang } from '@shared/api';
import { useAppState } from '../store/AppProvider';
import { dirOf, translate, type Params, type TKey } from './index';

export interface I18n {
  lang: UiLang;
  dir: 'rtl' | 'ltr';
  isRtl: boolean;
  t: (key: TKey, params?: Params) => string;
  /** Like t(), but turns <b>…</b> into <b> elements (no innerHTML). */
  rich: (key: TKey, params?: Params) => ReactNode;
}

export function useI18n(): I18n {
  const lang = useAppState().settings.uiLang;
  const t = useCallback((key: TKey, params?: Params) => translate(lang, key, params), [lang]);
  const rich = useCallback(
    (key: TKey, params?: Params): ReactNode => {
      const parts = translate(lang, key, params).split(/(<b>.*?<\/b>)/g);
      return parts.map((part, i) =>
        part.startsWith('<b>') ? (
          <b key={i}>{part.slice(3, -4)}</b>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      );
    },
    [lang],
  );
  return useMemo(
    () => ({ lang, dir: dirOf(lang), isRtl: lang === 'ar', t, rich }),
    [lang, t, rich],
  );
}
