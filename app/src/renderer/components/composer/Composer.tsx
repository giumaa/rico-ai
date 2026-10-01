import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { ArrowUp, ImagePlus, Square, X } from 'lucide-react';
import { useActions, useAppState } from '../../store/AppProvider';
import { visionBlocked } from '../../store/selectors';
import { useAutoGrow } from '../../hooks/useAutoGrow';
import { useI18n } from '../../i18n/useI18n';
import { MAX_IMAGES, imageSrc, isImageFile } from '../../lib/image';

export const COMPOSER_ID = 'composer-input';

/**
 * Sticky composer. dir="auto" lets the textarea flip RTL/LTR by the first strong
 * character the user types. Enter sends, Shift+Enter inserts a newline, Esc stops generation.
 * Images: attach button, paste, or drop anywhere on the chat (see App.tsx); max 4 per message.
 */
export function Composer() {
  const { t, dir } = useI18n();
  const state = useAppState();
  const { stream, activeChatId, booted, attachments, pendingImages } = state;
  const { sendMessage, stop, addImages, removeImage, toast } = useActions();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const streaming = !!stream;

  const noVision = visionBlocked(state);
  const full = attachments.length + pendingImages >= MAX_IMAGES;
  const attachLabel = noVision ? t('composer.attachDisabled') : full ? t('composer.maxImages') : t('composer.attach');

  useAutoGrow(ref, value);

  // focus on start and whenever another chat is opened
  useEffect(() => {
    if (booted) ref.current?.focus();
  }, [activeChatId, booted]);

  // refocus when a generation finishes
  useEffect(() => {
    if (!streaming) ref.current?.focus({ preventScroll: true });
  }, [streaming]);

  const hasContent = value.trim().length > 0 || attachments.length > 0;
  const canSend = hasContent && !streaming && !busy && pendingImages === 0;

  const submit = async () => {
    if (!canSend) return;
    const text = value;
    setBusy(true);
    try {
      const accepted = await sendMessage(text);
      if (accepted) setValue('');
    } finally {
      setBusy(false);
      ref.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape' && streaming) {
      e.preventDefault();
      stop();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files).filter(isImageFile);
    if (!files.length) return; // plain text paste: let the browser handle it
    e.preventDefault();
    void addImages(files);
  };

  const onAttachClick = () => {
    if (noVision || full) {
      toast('info', attachLabel);
      return;
    }
    fileRef.current?.click();
  };

  return (
    <div className="composer-wrap">
      <div className="composer">
        {attachments.length > 0 || pendingImages > 0 ? (
          <ul className="attach-strip" aria-label={t('composer.attach')}>
            {attachments.map((img, i) => (
              <li className="attach-thumb" key={img.id}>
                <img src={imageSrc(img)} alt={t('msg.imageAlt', { n: i + 1 })} />
                <button
                  type="button"
                  className="attach-remove"
                  aria-label={t('composer.removeImage')}
                  title={t('composer.removeImage')}
                  onClick={() => removeImage(img.id)}
                >
                  <X aria-hidden />
                </button>
              </li>
            ))}
            {Array.from({ length: pendingImages }, (_, i) => (
              <li className="attach-thumb attach-skeleton" key={`pending-${i}`} aria-hidden="true" />
            ))}
          </ul>
        ) : null}

        <div className="composer-row">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              void addImages(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <button
            type="button"
            className="attach-btn"
            aria-label={attachLabel}
            title={attachLabel}
            aria-disabled={noVision || full}
            onClick={onAttachClick}
          >
            <ImagePlus aria-hidden />
          </button>
          <textarea
            id={COMPOSER_ID}
            ref={ref}
            className="composer-input"
            dir={value ? 'auto' : dir}
            rows={1}
            value={value}
            placeholder={t('composer.placeholder')}
            aria-label={t('composer.placeholder')}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            spellCheck={false}
          />
          {streaming ? (
            <button type="button" className="stop-btn" onClick={stop} aria-label={t('composer.stop')} title={`${t('composer.stop')} (Esc)`}>
              <Square aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              className="send-btn"
              onClick={() => void submit()}
              disabled={!canSend}
              aria-label={t('composer.send')}
              title={`${t('composer.send')} (Enter)`}
            >
              <ArrowUp aria-hidden />
            </button>
          )}
        </div>
      </div>
      <div className="composer-hint">
        <span>
          <kbd className="kbd">Enter</kbd> {t('composer.hintSend')}
        </span>
        <span>
          <kbd className="kbd">Shift</kbd>+<kbd className="kbd">Enter</kbd> {t('composer.hintNewline')}
        </span>
        <span>{t('composer.disclaimer')}</span>
      </div>
    </div>
  );
}
