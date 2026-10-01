import { useEffect, useRef, useState } from 'react';
import { CircleCheck, CircleX, Info, X } from 'lucide-react';
import { useActions, useAppState } from '../../store/AppProvider';
import { useI18n } from '../../i18n/useI18n';
import type { Toast } from '../../store/types';

const LIFETIME: Record<Toast['kind'], number> = { info: 5500, success: 4500, error: 9000 };

function ToastItem({ toast }: { toast: Toast }) {
  const { t } = useI18n();
  const { dismissToast } = useActions();
  const [leaving, setLeaving] = useState(false);
  const [paused, setPaused] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const close = () => {
    setLeaving(true);
    window.setTimeout(() => dismissToast(toast.id), 200);
  };

  useEffect(() => {
    if (paused || leaving) return;
    timer.current = window.setTimeout(close, LIFETIME[toast.kind]);
    return () => window.clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, leaving]);

  const Icon = toast.kind === 'success' ? CircleCheck : toast.kind === 'error' ? CircleX : Info;
  return (
    <div
      className="toast"
      data-kind={toast.kind}
      data-leaving={leaving}
      role={toast.kind === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <Icon aria-hidden />
      <span className="toast-text" dir="auto">
        {toast.text}
      </span>
      {toast.action ? (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => {
            toast.action?.run();
            close();
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <button type="button" className="icon-btn icon-btn-sm" aria-label={t('toast.close')} onClick={close}>
        <X aria-hidden />
      </button>
    </div>
  );
}

export function Toaster() {
  const { toasts } = useAppState();
  return (
    <div className="toaster" aria-live="polite">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
