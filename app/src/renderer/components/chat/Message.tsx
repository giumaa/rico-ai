import { memo, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ChatMessage } from '@shared/api';
import type { StreamPhase } from '../../store/types';
import { scriptOf } from '../../lib/text';
import { imageSrc } from '../../lib/image';
import { useI18n } from '../../i18n/useI18n';
import { Logo } from '../brand/Logo';
import { CopyButton } from '../ui/CopyButton';
import { Lightbox } from '../ui/Lightbox';
import { Markdown } from './Markdown';

interface MessageProps {
  message: ChatMessage;
  /** this assistant message is currently being generated */
  streaming: boolean;
  phase?: StreamPhase;
  isLast: boolean;
  onRegenerate?: () => void;
}

export const Message = memo(function Message({ message, streaming, phase, isLast, onRegenerate }: MessageProps) {
  const { t } = useI18n();
  const [lightbox, setLightbox] = useState<number | null>(null);
  // re-detect only when the beginning changes, not on every streamed token
  const head = message.content.slice(0, 400);
  const script = useMemo(() => scriptOf(head), [head]);

  const images = message.images ?? [];
  if (message.role === 'user') {
    return (
      <article className="msg msg-user" data-script={script} data-last={isLast}>
        {images.length > 0 ? (
          <div className="msg-images" data-count={images.length}>
            {images.map((img, i) => (
              <button
                key={img.id}
                type="button"
                className="msg-image"
                aria-label={t('msg.imageAlt', { n: i + 1 })}
                onClick={() => setLightbox(i)}
              >
                <img src={imageSrc(img)} alt={t('msg.imageAlt', { n: i + 1 })} loading="lazy" />
              </button>
            ))}
          </div>
        ) : null}
        {message.content ? (
          <div className="msg-bubble" dir="auto">
            {message.content}
          </div>
        ) : null}
        {message.content ? (
          <div className="msg-actions">
            <CopyButton getText={() => message.content} />
          </div>
        ) : null}
        {lightbox !== null ? <Lightbox images={images} index={lightbox} onClose={() => setLightbox(null)} /> : null}
      </article>
    );
  }

  const waiting = streaming && message.content.length === 0;
  return (
    <article
      className="msg msg-assistant"
      data-script={script}
      data-streaming={streaming}
      data-last={isLast}
      aria-busy={streaming}
    >
      <div className="msg-avatar">
        <Logo size={32} />
      </div>
      <div className="msg-body">
        {waiting ? (
          <div className="typing" role="status">
            <span className="typing-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>{phase === 'loading-model' ? t('msg.phase.loading') : t('msg.phase.thinking')}</span>
          </div>
        ) : (
          <Markdown content={message.content} streaming={streaming} />
        )}
        {!waiting && (
          <div className="msg-actions">
            <CopyButton getText={() => message.content} />
            {isLast && !streaming && onRegenerate ? (
              <button type="button" className="act-btn" onClick={onRegenerate}>
                <RefreshCw aria-hidden />
                <span>{t('msg.regenerate')}</span>
              </button>
            ) : null}
          </div>
        )}
      </div>
    </article>
  );
});
