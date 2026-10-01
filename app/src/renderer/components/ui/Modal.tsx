import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useI18n } from '../../i18n/useI18n';
import { IconButton } from './IconButton';

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** only the top-most modal reacts to Escape / Tab */
const stack: symbol[] = [];

interface ModalProps {
  title: string;
  onClose: () => void;
  size?: 'sm' | 'md' | 'lg';
  footer?: ReactNode;
  /** content area manages its own padding/scroll (settings) */
  bare?: boolean;
  children: ReactNode;
}

export function Modal({ title, onClose, size = 'md', footer, bare, children }: ModalProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleId = useId();

  useEffect(() => {
    const id = Symbol('modal');
    stack.push(id);
    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = () =>
      dialog ? Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null) : [];

    const auto = dialog?.querySelector<HTMLElement>('[data-autofocus]');
    (auto ?? focusables().find((el) => !el.classList.contains('modal-close')) ?? dialog)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        closeRef.current();
      } else if (e.key === 'Tab') {
        const items = focusables();
        if (!items.length) {
          e.preventDefault();
          return;
        }
        const first = items[0]!;
        const last = items[items.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !dialog?.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !dialog?.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
      previouslyFocused?.focus?.();
    };
  }, []);

  return createPortal(
    <div className="modal-layer">
      <div className="modal-scrim" onMouseDown={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        className="modal"
        data-size={size}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="modal-head">
          <h2 id={titleId} className="modal-title">
            {title}
          </h2>
          <IconButton label={t('common.close')} className="modal-close" onClick={onClose}>
            <X />
          </IconButton>
        </header>
        {bare ? children : <div className="modal-body">{children}</div>}
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
