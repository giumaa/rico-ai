import { isValidElement, type ReactNode } from 'react';
import { nodeToText } from '../../lib/text';
import { useI18n } from '../../i18n/useI18n';
import { CopyButton } from '../ui/CopyButton';

interface CodeBlockProps {
  children?: ReactNode;
}

/** `pre` renderer: header with language + copy button, horizontally scrollable, always LTR. */
export function CodeBlock({ children }: CodeBlockProps) {
  const { t } = useI18n();
  const codeEl = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children : null;
  const className = codeEl?.props.className ?? '';
  const lang = /language-([\w+#-]+)/.exec(className)?.[1] ?? '';
  const getText = () => nodeToText(codeEl?.props.children ?? children).replace(/\n$/, '');

  return (
    <div className="code-block" dir="ltr">
      <div className="code-head">
        <span className="code-lang">{lang || 'text'}</span>
        <CopyButton getText={getText} label={t('code.copy')} className="act-btn" />
      </div>
      <pre tabIndex={0}>{children}</pre>
    </div>
  );
}
