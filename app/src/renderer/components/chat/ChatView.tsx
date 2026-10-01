import { useMemo, useRef } from 'react';
import { ChevronDown, TriangleAlert } from 'lucide-react';
import { useActions, useAppState } from '../../store/AppProvider';
import { useStickToBottom } from '../../hooks/useStickToBottom';
import { useI18n } from '../../i18n/useI18n';
import { Hero } from './Hero';
import { Message } from './Message';

export function ChatView() {
  const { t } = useI18n();
  const { activeChatId, chats, stream, chatError } = useAppState();
  const { sendMessage, regenerate } = useActions();
  const scrollRef = useRef<HTMLDivElement>(null);

  const chat = activeChatId ? chats[activeChatId] : undefined;
  const messages = useMemo(() => chat?.messages ?? [], [chat]);
  const last = messages[messages.length - 1];

  // follow the stream: re-run on new messages and on every streamed chunk
  const signal = `${messages.length}:${last?.content.length ?? 0}:${chatError ? 1 : 0}`;
  const { atBottom, hasNew, scrollToBottom } = useStickToBottom(scrollRef, signal, activeChatId);

  const empty = messages.length === 0;
  const errorHere = chatError && chatError.chatId === activeChatId ? chatError : null;

  return (
    <div className="chat-wrap">
      <div className="chat-scroll" ref={scrollRef} tabIndex={0}>
      {empty && !errorHere ? (
        <Hero onPick={(text) => void sendMessage(text)} />
      ) : (
        <div className="chat-col" role="log" aria-live="off" aria-label={chat?.title}>
          {messages.map((m, i) => {
            const isStreaming = stream?.assistantId === m.id;
            return (
              <Message
                key={m.id}
                message={m}
                streaming={isStreaming}
                phase={isStreaming ? stream.phase : undefined}
                isLast={i === messages.length - 1}
                onRegenerate={regenerate}
              />
            );
          })}
          {errorHere ? (
            <div className="chat-error" role="alert">
              <TriangleAlert aria-hidden />
              <span className="chat-error-text" dir="auto">
                {errorHere.message || t('error.generic')}
              </span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={regenerate} disabled={!!stream}>
                {t('error.retry')}
              </button>
            </div>
          ) : null}
        </div>
      )}
      </div>

      <div className="scroll-down" data-visible={!atBottom && !empty}>
        <button
          type="button"
          className="scroll-down-btn"
          aria-label={hasNew ? `${t('msg.scrollDown')} — ${t('msg.newContent')}` : t('msg.scrollDown')}
          title={t('msg.scrollDown')}
          tabIndex={!atBottom && !empty ? 0 : -1}
          onClick={() => scrollToBottom()}
        >
          <ChevronDown aria-hidden />
          {hasNew ? <span className="scroll-down-dot" aria-hidden="true" /> : null}
        </button>
      </div>
    </div>
  );
}
