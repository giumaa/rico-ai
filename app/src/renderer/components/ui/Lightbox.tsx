import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import type { ImageAttachment } from '@shared/api';
import { imageSrc } from '../../lib/image';
import { useI18n } from '../../i18n/useI18n';

interface LightboxProps {
  images: ImageAttachment[];
  index: number;
  onClose: () => void;
}

/** Full-size image viewer: click the backdrop or press Esc to close, ←/→ to browse. */
export function Lightbox({ images, index, onClose }: LightboxProps) {
  const { t } = useI18n();
  const [i, setI] = useState(index);
  const closeRef = useRef<HTMLButtonElement>(null);
  const count = images.length;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      } else if (count > 1 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        const rtl = document.documentElement.dir === 'rtl';
        const forward = e.key === (rtl ? 'ArrowLeft' : 'ArrowRight');
        setI((cur) => (cur + (forward ? 1 : -1) + count) % count);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [count, onClose]);

  const img = images[i];
  if (!img) return null;
  const rtl = document.documentElement.dir === 'rtl';
  const Prev = rtl ? ChevronRight : ChevronLeft;
  const Next = rtl ? ChevronLeft : ChevronRight;

  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={t('msg.imageAlt', { n: i + 1 })} onMouseDown={onClose}>
      <button ref={closeRef} type="button" className="lightbox-close icon-btn" aria-label={t('lightbox.close')} onClick={onClose}>
        <X aria-hidden />
      </button>
      {count > 1 ? (
        <button
          type="button"
          className="lightbox-nav lightbox-prev icon-btn"
          aria-label="‹"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setI((cur) => (cur - 1 + count) % count)}
        >
          <Prev aria-hidden />
        </button>
      ) : null}
      <img
        className="lightbox-img"
        src={imageSrc(img)}
        alt={t('msg.imageAlt', { n: i + 1 })}
        onMouseDown={(e) => e.stopPropagation()}
      />
      {count > 1 ? (
        <button
          type="button"
          className="lightbox-nav lightbox-next icon-btn"
          aria-label="›"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setI((cur) => (cur + 1) % count)}
        >
          <Next aria-hidden />
        </button>
      ) : null}
    </div>,
    document.body,
  );
}
