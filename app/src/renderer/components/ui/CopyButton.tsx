import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyText } from '../../lib/clipboard';
import { useI18n } from '../../i18n/useI18n';

interface CopyButtonProps {
  getText: () => string;
  label?: string;
  /** show the text label next to the icon */
  withLabel?: boolean;
  className?: string;
}

export function CopyButton({ getText, label, withLabel = true, className = 'act-btn' }: CopyButtonProps) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const text = label ?? t('msg.copy');
  return (
    <button
      type="button"
      className={className}
      data-done={done}
      aria-label={done ? t('msg.copied') : text}
      title={done ? t('msg.copied') : text}
      onClick={async () => {
        const ok = await copyText(getText());
        if (!ok) return;
        setDone(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setDone(false), 1800);
      }}
    >
      {done ? <Check aria-hidden /> : <Copy aria-hidden />}
      {withLabel ? <span aria-live="polite">{done ? t('msg.copied') : text}</span> : null}
    </button>
  );
}
