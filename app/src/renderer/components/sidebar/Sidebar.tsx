import { useMemo, useState } from 'react';
import { PanelLeftClose, Pin, Plus, Search, Settings, ShieldCheck } from 'lucide-react';
import type { ChatSummary } from '@shared/api';
import { useActions, useAppState } from '../../store/AppProvider';
import { dayBucket, type DayBucket } from '../../lib/format';
import { useI18n } from '../../i18n/useI18n';
import { MOD_LABEL } from '../../lib/platform';
import type { TKey } from '../../i18n';
import { Logo } from '../brand/Logo';
import { IconButton } from '../ui/IconButton';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ChatListItem } from './ChatListItem';

const BUCKET_LABEL: Record<DayBucket, TKey> = {
  today: 'sidebar.today',
  yesterday: 'sidebar.yesterday',
  week: 'sidebar.week',
  older: 'sidebar.older',
};
const BUCKET_ORDER: DayBucket[] = ['today', 'yesterday', 'week', 'older'];

export const SEARCH_ID = 'sidebar-search';

export function Sidebar() {
  const { t, dir } = useI18n();
  const { chatIndex, activeChatId, search, sidebarOpen } = useAppState();
  const a = useActions();
  const [pendingDelete, setPendingDelete] = useState<ChatSummary | null>(null);

  const { pinned, groups, total } = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = (q ? chatIndex.filter((c) => c.title.toLowerCase().includes(q)) : chatIndex)
      .slice()
      .sort((x, y) => y.updatedAt - x.updatedAt);
    const pinnedList = filtered.filter((c) => c.pinned);
    const rest = filtered.filter((c) => !c.pinned);
    const now = Date.now();
    const byBucket = new Map<DayBucket, ChatSummary[]>();
    for (const c of rest) {
      const b = dayBucket(c.updatedAt, now);
      byBucket.set(b, [...(byBucket.get(b) ?? []), c]);
    }
    return {
      pinned: pinnedList,
      groups: BUCKET_ORDER.filter((b) => byBucket.has(b)).map((b) => ({ bucket: b, items: byBucket.get(b)! })),
      total: filtered.length,
    };
  }, [chatIndex, search]);

  const closeIfDrawer = () => {
    if (window.matchMedia('(max-width: 880px)').matches) a.setSidebar(false);
  };

  const renderItem = (c: ChatSummary) => (
    <ChatListItem
      key={c.id}
      chat={c}
      active={c.id === activeChatId}
      onOpen={(id) => {
        void a.openChat(id);
        closeIfDrawer();
      }}
      onRename={a.renameChat}
      onTogglePin={a.togglePin}
      onDelete={setPendingDelete}
    />
  );

  return (
    <>
      <aside className="sidebar" aria-label={t('app.name')} inert={!sidebarOpen}>
        <div className="sidebar-inner">
          <div className="sb-top drag">
            <div className="sb-brand">
              <Logo size={30} />
              <span className="sb-brand-name">{t('app.name')}</span>
            </div>
            <IconButton label={t('sidebar.collapse')} onClick={() => a.setSidebar(false)}>
              <PanelLeftClose className="flip-rtl" aria-hidden />
            </IconButton>
          </div>

          <div className="sb-actions">
            <button
              type="button"
              className="btn btn-primary sb-new"
              onClick={() => {
                a.newChat();
                closeIfDrawer();
                document.getElementById('composer-input')?.focus();
              }}
            >
              <Plus aria-hidden />
              <span>{t('sidebar.newChat')}</span>
              <kbd>{MOD_LABEL} N</kbd>
            </button>
            <div className="sb-search">
              <Search aria-hidden />
              <input
                id={SEARCH_ID}
                className="input"
                type="search"
                dir={search ? 'auto' : dir}
                value={search}
                placeholder={t('sidebar.search')}
                aria-label={t('sidebar.search')}
                onChange={(e) => a.setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') a.setSearch('');
                }}
              />
            </div>
          </div>

          <nav className="sb-list" aria-label={t('sidebar.search')}>
            {total === 0 ? (
              <p className="sb-empty">
                {search.trim() ? t('sidebar.noResults') : t('sidebar.empty')}
              </p>
            ) : null}

            {pinned.length > 0 ? (
              <section>
                <h3 className="sb-group-label">
                  <Pin aria-hidden />
                  {t('sidebar.pinned')}
                </h3>
                <ul>{pinned.map(renderItem)}</ul>
              </section>
            ) : null}

            {groups.map(({ bucket, items }) => (
              <section key={bucket}>
                <h3 className="sb-group-label">{t(BUCKET_LABEL[bucket])}</h3>
                <ul>{items.map(renderItem)}</ul>
              </section>
            ))}
          </nav>

          <div className="sb-foot">
            <div className="sb-offline" title={t('app.tagline')}>
              <ShieldCheck aria-hidden />
              <span>{t('sidebar.offline')}</span>
            </div>
            <IconButton label={`${t('sidebar.settings')} (${MOD_LABEL} ,)`} onClick={() => a.openSettings('general')}>
              <Settings aria-hidden />
            </IconButton>
          </div>
        </div>
      </aside>

      {pendingDelete ? (
        <ConfirmDialog
          title={t('chat.deleteTitle')}
          body={t('chat.deleteBody', { title: pendingDelete.title || t('chat.untitled') })}
          confirmLabel={t('chat.delete')}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            a.deleteChat(pendingDelete.id);
            setPendingDelete(null);
          }}
        />
      ) : null}
    </>
  );
}
