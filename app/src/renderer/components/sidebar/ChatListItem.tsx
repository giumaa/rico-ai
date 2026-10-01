import { useEffect, useRef, useState } from 'react';
import { Ellipsis, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import type { ChatSummary } from '@shared/api';
import { useI18n } from '../../i18n/useI18n';
import { MenuButton, type MenuItemDef } from '../ui/MenuButton';

interface ChatListItemProps {
  chat: ChatSummary;
  active: boolean;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string) => void;
  onDelete: (chat: ChatSummary) => void;
}

export function ChatListItem({ chat, active, onOpen, onRename, onTogglePin, onDelete }: ChatListItemProps) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [draft, setDraft] = useState(chat.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const title = chat.title || t('chat.untitled');

  useEffect(() => {
    if (editing) {
      setDraft(chat.title);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing, chat.title]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== chat.title) onRename(chat.id, next);
  };

  const items: MenuItemDef[] = [
    { id: 'rename', label: t('chat.rename'), icon: <Pencil aria-hidden />, onSelect: () => setEditing(true) },
    {
      id: 'pin',
      label: chat.pinned ? t('chat.unpin') : t('chat.pin'),
      icon: chat.pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />,
      onSelect: () => onTogglePin(chat.id),
    },
    { id: 'delete', label: t('chat.delete'), icon: <Trash2 aria-hidden />, danger: true, onSelect: () => onDelete(chat) },
  ];

  return (
    <li className="sb-item" data-active={active} data-menu-open={menuOpen}>
      {editing ? (
        <input
          ref={inputRef}
          className="input sb-rename"
          dir="auto"
          value={draft}
          maxLength={120}
          aria-label={t('chat.rename')}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              e.stopPropagation();
              setEditing(false);
            }
          }}
        />
      ) : (
        <>
          <button
            type="button"
            className="sb-item-btn"
            aria-current={active ? 'page' : undefined}
            onClick={() => onOpen(chat.id)}
            onDoubleClick={() => setEditing(true)}
            title={title}
          >
            {chat.pinned ? <Pin className="sb-item-pin" aria-hidden /> : null}
            <span className="sb-item-title" dir="auto">
              {title}
            </span>
          </button>
          <MenuButton
            label={t('chat.more')}
            icon={<Ellipsis aria-hidden />}
            items={items}
            className="sb-item-more"
            onOpenChange={setMenuOpen}
          />
        </>
      )}
    </li>
  );
}
