import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import type {
  Chat,
  ChatMessage,
  DoneEvent,
  ErrorEvent,
  ModelEntry,
  Settings,
  TokenEvent,
} from '@shared/api';
import { translate, type Params, type TKey } from '../i18n';
import { MAX_IMAGES, fileToAttachment, isImageFile } from '../lib/image';
import { makeTitle, uid } from '../lib/text';
import { visionBlocked } from './selectors';
import { DEFAULT_SETTINGS, initialState, reducer } from './reducer';
import type { AppState, SettingsTab, ToastAction, ToastKind } from './types';

export interface Actions {
  /** Resolves true when the message was accepted (composer can clear itself). */
  sendMessage(text: string): Promise<boolean>;
  /** downscale + stage images for the next message (max 4) */
  addImages(files: File[]): Promise<void>;
  removeImage(id: string): void;
  stop(): void;
  regenerate(): void;
  newChat(): void;
  openChat(id: string): Promise<void>;
  renameChat(id: string, title: string): void;
  togglePin(id: string): void;
  deleteChat(id: string): void;
  deleteAllChats(): Promise<void>;

  updateSettings(patch: Partial<Settings>): void;
  /** local-only live preview (e.g. while dragging a slider); persist with updateSettings */
  previewSettings(patch: Partial<Settings>): void;

  setSidebar(open: boolean): void;
  toggleSidebar(): void;
  setSearch(query: string): void;
  openSettings(tab?: SettingsTab): void;
  closeModal(): void;
  openModelScreen(): void;
  closeOnboarding(): void;

  refreshModels(): Promise<ModelEntry[]>;
  downloadModel(id: string): Promise<void>;
  cancelDownload(id: string): Promise<void>;
  importModel(): Promise<void>;
  removeModel(id: string): Promise<void>;
  activateModel(id: string): Promise<void>;

  toast(kind: ToastKind, text: string, action?: ToastAction): void;
  dismissToast(id: string): void;
}

const StateCtx = createContext<AppState>(initialState);
const ActionsCtx = createContext<Actions | null>(null);

export const useAppState = (): AppState => useContext(StateCtx);
export function useActions(): Actions {
  const a = useContext(ActionsCtx);
  if (!a) throw new Error('useActions must be used inside <AppProvider>');
  return a;
}

// ---------------------------------------------------------------------------
type GenEvent =
  | { kind: 'token'; e: TokenEvent }
  | { kind: 'done'; e: DoneEvent }
  | { kind: 'error'; e: ErrorEvent };

interface Generation {
  chatId: string;
  assistantId: string;
  requestId: string | null;
  /** events that arrived before generate() resolved with its requestId */
  early: GenEvent[];
  buffer: string;
  flushTimer: number | null;
  started: boolean;
  stopRequested: boolean;
  settled: boolean;
}

/** wire format for generate(): role + text, plus images only when present */
const toHistory = (messages: ChatMessage[]): Pick<ChatMessage, 'role' | 'content' | 'images'>[] =>
  messages.map((m) => (m.images?.length ? { role: m.role, content: m.content, images: m.images } : { role: m.role, content: m.content }));

const FLUSH_MS = 40;
const LOAD_TIMEOUT_MS = 180_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const genRef = useRef<Generation | null>(null);
  const lastDownloadError = useRef<Record<string, number>>({});

  const tr = useCallback(
    (key: TKey, params?: Params) => translate(stateRef.current.settings.uiLang, key, params),
    [],
  );

  // ------------------------------------------------------------ toasts
  const pushToast = useCallback((kind: ToastKind, text: string, action?: ToastAction) => {
    dispatch({ type: 'TOAST_PUSH', toast: { id: uid(), kind, text, action } });
  }, []);

  const modelName = useCallback((id: string): string => {
    const m = stateRef.current.models.find((x) => x.id === id);
    return m ? m.name[stateRef.current.settings.uiLang] : id;
  }, []);

  // ------------------------------------------------------------ models
  const refreshModels = useCallback(async (): Promise<ModelEntry[]> => {
    try {
      const models = await window.rico.models.list();
      dispatch({ type: 'MODELS', models });
      return models;
    } catch {
      return stateRef.current.models;
    }
  }, []);

  const refreshLoadState = useCallback(async () => {
    try {
      const loadState = await window.rico.models.getLoadState();
      dispatch({ type: 'LOAD_STATE', loadState });
      return loadState;
    } catch {
      return stateRef.current.loadState;
    }
  }, []);

  const activateModel = useCallback(
    async (id: string) => {
      dispatch({ type: 'LOAD_STATE', loadState: { modelId: id, state: 'loading' } });
      try {
        await window.rico.models.setActive(id);
        const ls = await refreshLoadState();
        await refreshModels();
        if (ls.state === 'error') {
          pushToast('error', tr('toast.modelLoadFailed', { error: ls.error ?? '' }));
        } else {
          pushToast('success', tr('toast.activated', { name: modelName(id) }));
        }
      } catch (e) {
        await refreshLoadState();
        pushToast('error', tr('toast.modelLoadFailed', { error: errMsg(e) }));
      }
    },
    [modelName, pushToast, refreshLoadState, refreshModels, tr],
  );

  const downloadModel = useCallback(
    async (id: string) => {
      try {
        dispatch({
          type: 'DOWNLOAD',
          progress: { modelId: id, receivedBytes: 0, totalBytes: 0, bytesPerSecond: 0, status: 'downloading' },
        });
        await window.rico.models.download(id);
      } catch (e) {
        // main may also push an 'error' progress event for the same failure: toast only once
        if (Date.now() - (lastDownloadError.current[id] ?? 0) > 3000) {
          lastDownloadError.current[id] = Date.now();
          pushToast('error', tr('toast.downloadFailed', { error: errMsg(e) }));
        }
        dispatch({ type: 'DOWNLOAD_CLEAR', modelId: id });
        void refreshModels();
      }
    },
    [pushToast, refreshModels, tr],
  );

  const cancelDownload = useCallback(
    async (id: string) => {
      try {
        await window.rico.models.cancelDownload(id);
      } finally {
        dispatch({ type: 'DOWNLOAD_CLEAR', modelId: id });
        void refreshModels();
      }
    },
    [refreshModels],
  );

  const importModel = useCallback(async () => {
    try {
      const entry = await window.rico.models.importFile();
      if (!entry) return; // dialog cancelled
      const list = await refreshModels();
      pushToast('success', tr('toast.imported', { name: entry.name[stateRef.current.settings.uiLang] }));
      if (!list.some((m) => m.isActive && m.id !== entry.id)) await activateModel(entry.id);
    } catch {
      pushToast('error', tr('toast.importFailed'));
    }
  }, [activateModel, pushToast, refreshModels, tr]);

  const removeModel = useCallback(
    async (id: string) => {
      try {
        await window.rico.models.remove(id);
        pushToast('info', tr('toast.removed'));
      } catch (e) {
        pushToast('error', errMsg(e));
      } finally {
        await refreshModels();
        await refreshLoadState();
      }
    },
    [pushToast, refreshLoadState, refreshModels, tr],
  );

  // ------------------------------------------------------------ settings
  const updateSettings = useCallback(
    (patch: Partial<Settings>) => {
      dispatch({ type: 'SETTINGS_PATCH', patch });
      window.rico.settings
        .set(patch)
        .then((s) => dispatch({ type: 'SETTINGS', settings: s }))
        .catch(() => pushToast('error', tr('toast.settingsFailed')));
    },
    [pushToast, tr],
  );
  const previewSettings = useCallback((patch: Partial<Settings>) => {
    dispatch({ type: 'SETTINGS_PATCH', patch });
  }, []);

  // ------------------------------------------------------------ generation
  const flush = useCallback((g: Generation) => {
    if (g.flushTimer !== null) {
      window.clearTimeout(g.flushTimer);
      g.flushTimer = null;
    }
    if (!g.buffer) return;
    const text = g.buffer;
    g.buffer = '';
    dispatch({ type: 'STREAM_CHUNK', chatId: g.chatId, messageId: g.assistantId, text });
  }, []);

  const settle = useCallback((g: Generation) => {
    g.settled = true;
    if (genRef.current === g) genRef.current = null;
  }, []);

  const applyEvent = useCallback(
    (g: Generation, ev: GenEvent) => {
      if (g.settled) return;
      if (ev.kind === 'token') {
        if (!g.started) {
          g.started = true;
          dispatch({ type: 'STREAM_PHASE', phase: 'streaming' });
        }
        g.buffer += ev.e.chunk;
        if (g.flushTimer === null) {
          g.flushTimer = window.setTimeout(() => {
            g.flushTimer = null;
            flush(g);
          }, FLUSH_MS);
        }
      } else if (ev.kind === 'done') {
        flush(g);
        settle(g);
        dispatch({ type: 'TURN_END', chatId: g.chatId, messageId: g.assistantId, text: ev.e.text });
      } else {
        flush(g);
        settle(g);
        dispatch({ type: 'TURN_ERROR', chatId: g.chatId, messageId: g.assistantId, message: ev.e.message });
        pushToast('error', `${tr('error.generic')}: ${ev.e.message}`);
      }
    },
    [flush, pushToast, settle, tr],
  );

  const handleEvent = useCallback(
    (ev: GenEvent) => {
      const g = genRef.current;
      if (!g) return;
      if (g.requestId === null) {
        g.early.push(ev);
        return;
      }
      if (ev.e.requestId !== g.requestId) return;
      applyEvent(g, ev);
    },
    [applyEvent],
  );

  // single subscription for the lifetime of the app
  useEffect(() => {
    const api = window.rico;
    const offs = [
      api.chat.onToken((e) => handleEvent({ kind: 'token', e })),
      api.chat.onDone((e) => handleEvent({ kind: 'done', e })),
      api.chat.onError((e) => handleEvent({ kind: 'error', e })),
    ];
    return () => offs.forEach((off) => off());
  }, [handleEvent]);

  /** Wake the engine if needed. Throws on failure; resolves once a model is ready. */
  const ensureModelReady = useCallback(
    async (g: Generation) => {
      const api = window.rico;
      let ls = await api.models.getLoadState();
      dispatch({ type: 'LOAD_STATE', loadState: ls });
      if (ls.state === 'ready') return;

      if (ls.state === 'idle' || ls.state === 'error') {
        dispatch({ type: 'STREAM_PHASE', phase: 'loading-model' });
        const list = await refreshModels();
        const installed = list.filter((m) => m.status === 'installed');
        if (!installed.length) throw new Error('NO_MODEL');
        const wanted = stateRef.current.settings.activeModelId;
        const target =
          installed.find((m) => m.id === wanted) ?? installed.find((m) => m.isActive) ?? installed[0]!;
        await api.models.setActive(target.id);
        ls = await api.models.getLoadState();
        dispatch({ type: 'LOAD_STATE', loadState: ls });
      }

      const started = Date.now();
      while (ls.state === 'loading') {
        dispatch({ type: 'STREAM_PHASE', phase: 'loading-model' });
        if (g.settled || g.stopRequested) return;
        if (Date.now() - started > LOAD_TIMEOUT_MS) throw new Error('LOAD_TIMEOUT');
        await sleep(450);
        ls = await api.models.getLoadState();
        dispatch({ type: 'LOAD_STATE', loadState: ls });
      }
      if (ls.state === 'error') throw new Error(ls.error ?? 'MODEL_ERROR');
      void refreshModels();
    },
    [refreshModels],
  );

  const runGeneration = useCallback(
    async (chatId: string, assistantId: string, history: Pick<ChatMessage, 'role' | 'content'>[]) => {
      const g: Generation = {
        chatId,
        assistantId,
        requestId: null,
        early: [],
        buffer: '',
        flushTimer: null,
        started: false,
        stopRequested: false,
        settled: false,
      };
      genRef.current = g;
      try {
        await ensureModelReady(g);
        if (g.settled) return; // stopped while the model was loading
        dispatch({ type: 'STREAM_PHASE', phase: 'thinking' });
        const { requestId } = await window.rico.chat.generate({ chatId, messages: history });
        if (g.settled) {
          void window.rico.chat.stop(requestId).catch(() => undefined);
          return;
        }
        g.requestId = requestId;
        if (g.stopRequested) void window.rico.chat.stop(requestId).catch(() => undefined);
        const early = g.early.splice(0);
        for (const ev of early) {
          if (ev.e.requestId === requestId) applyEvent(g, ev);
        }
      } catch (e) {
        if (g.settled) return;
        flush(g);
        settle(g);
        const msg = errMsg(e);
        if (msg === 'NO_MODEL') {
          dispatch({ type: 'TURN_ERROR', chatId, messageId: assistantId, message: tr('toast.noModel') });
          dispatch({ type: 'ONBOARDING', on: true });
          pushToast('info', tr('toast.noModel'));
        } else if (msg === 'LOAD_TIMEOUT') {
          dispatch({ type: 'TURN_ERROR', chatId, messageId: assistantId, message: tr('toast.loadTimeout') });
          pushToast('error', tr('toast.loadTimeout'));
        } else {
          dispatch({ type: 'TURN_ERROR', chatId, messageId: assistantId, message: msg });
          pushToast('error', `${tr('error.generic')}: ${msg}`);
        }
      }
    },
    [applyEvent, ensureModelReady, flush, pushToast, settle, tr],
  );

  const stop = useCallback(() => {
    const g = genRef.current;
    if (!g || g.settled) return;
    g.stopRequested = true;
    if (g.requestId) {
      window.rico.chat.stop(g.requestId).catch(() => undefined);
      // safety net: if main never reports `done`, finalise locally
      window.setTimeout(() => {
        if (!g.settled) {
          flush(g);
          settle(g);
          dispatch({ type: 'TURN_END', chatId: g.chatId, messageId: g.assistantId });
        }
      }, 4000);
    } else {
      // still waiting for the model / requestId: end now, runGeneration cleans up
      flush(g);
      settle(g);
      dispatch({ type: 'TURN_END', chatId: g.chatId, messageId: g.assistantId });
    }
  }, [flush, settle]);

  /** Quick pre-flight so "no model" can be reported before the message is appended. */
  const preflight = useCallback(async (): Promise<boolean> => {
    try {
      const ls = await refreshLoadState();
      if (ls.state === 'ready' || ls.state === 'loading') return true;
      const list = await refreshModels();
      return list.some((m) => m.status === 'installed');
    } catch {
      return true; // let generate() surface the real error
    }
  }, [refreshLoadState, refreshModels]);

  const openModelScreen = useCallback(() => dispatch({ type: 'ONBOARDING', on: true }), []);

  const sendMessage = useCallback(
    async (raw: string): Promise<boolean> => {
      const text = raw.trim();
      const images = stateRef.current.attachments;
      if ((!text && !images.length) || stateRef.current.stream || stateRef.current.pendingImages > 0) return false;
      if (images.length && visionBlocked(stateRef.current)) {
        pushToast('info', tr('toast.noVision'));
        return false;
      }

      const ok = await preflight();
      if (!ok) {
        pushToast('info', tr('toast.noModel'), {
          label: tr('toast.openModels'),
          run: () => dispatch({ type: 'ONBOARDING', on: true }),
        });
        dispatch({ type: 'ONBOARDING', on: true });
        return false;
      }

      const s = stateRef.current;
      const now = Date.now();
      const chatId = s.activeChatId ?? uid();
      const existing = s.chats[chatId];
      const userMsg: ChatMessage = {
        id: uid(),
        role: 'user',
        content: text,
        createdAt: now,
        ...(images.length ? { images } : {}),
      };
      const assistantMsg: ChatMessage = { id: uid(), role: 'assistant', content: '', createdAt: now + 1 };
      const history = toHistory([...(existing?.messages ?? []), userMsg]);

      dispatch({
        type: 'TURN_START',
        chatId,
        title: makeTitle(text) || (images.length ? tr('chat.imageTitle') : tr('chat.untitled')),
        userMsg,
        assistantMsg,
        now,
      });
      dispatch({ type: 'ATTACH_CLEAR' });
      void runGeneration(chatId, assistantMsg.id, history);
      return true;
    },
    [preflight, pushToast, runGeneration, tr],
  );

  const addImages = useCallback(
    async (files: File[]) => {
      const imgs = files.filter(isImageFile);
      if (!imgs.length) return;
      const s = stateRef.current;
      if (visionBlocked(s)) {
        pushToast('info', tr('toast.noVision'));
        return;
      }
      const room = MAX_IMAGES - s.attachments.length - s.pendingImages;
      if (imgs.length > room) pushToast('info', tr('composer.maxImages'));
      const take = imgs.slice(0, Math.max(0, room));
      if (!take.length) return;
      dispatch({ type: 'ATTACH_PENDING', delta: take.length });
      const results = await Promise.allSettled(take.map(fileToAttachment));
      dispatch({ type: 'ATTACH_PENDING', delta: -take.length });
      const ok = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      if (ok.length) dispatch({ type: 'ATTACH_ADD', images: ok });
      if (ok.length < take.length) pushToast('error', tr('toast.imageFailed'));
    },
    [pushToast, tr],
  );

  const regenerate = useCallback(() => {
    const s = stateRef.current;
    if (s.stream || !s.activeChatId) return;
    const chat = s.chats[s.activeChatId];
    if (!chat) return;
    const last = chat.messages[chat.messages.length - 1];
    const base = last && last.role === 'assistant' ? chat.messages.slice(0, -1) : chat.messages;
    if (!base.length || base[base.length - 1]!.role !== 'user') return;
    const now = Date.now();
    const assistantMsg: ChatMessage = { id: uid(), role: 'assistant', content: '', createdAt: now };
    dispatch({ type: 'TURN_RESTART', chatId: chat.id, assistantMsg, now });
    void runGeneration(
      chat.id,
      assistantMsg.id,
      toHistory(base),
    );
  }, [runGeneration]);

  // ------------------------------------------------------------ chats
  const openChat = useCallback(async (id: string) => {
    if (stateRef.current.activeChatId === id) return;
    if (!stateRef.current.chats[id]) {
      try {
        const chat = await window.rico.chats.get(id);
        if (!chat) {
          dispatch({ type: 'CHAT_DELETE', id });
          return;
        }
        dispatch({ type: 'CHAT_LOADED', chat });
      } catch {
        pushToast('error', tr('toast.generic'));
        return;
      }
    }
    dispatch({ type: 'CHAT_OPEN', id });
  }, [pushToast, tr]);

  const newChat = useCallback(() => dispatch({ type: 'CHAT_OPEN', id: null }), []);

  /** Make sure the full chat is cached before patching it (title / pin). */
  const ensureChatLoaded = useCallback(async (id: string): Promise<Chat | null> => {
    const cached = stateRef.current.chats[id];
    if (cached) return cached;
    try {
      const chat = await window.rico.chats.get(id);
      if (chat) dispatch({ type: 'CHAT_LOADED', chat });
      return chat;
    } catch {
      return null;
    }
  }, []);

  const renameChat = useCallback(
    (id: string, title: string) => {
      const clean = title.replace(/\s+/g, ' ').trim();
      if (!clean) return;
      void ensureChatLoaded(id).then((chat) => {
        if (chat) dispatch({ type: 'CHAT_PATCH', id, patch: { title: clean } });
      });
    },
    [ensureChatLoaded],
  );

  const togglePin = useCallback(
    (id: string) => {
      const pinned = !!stateRef.current.chatIndex.find((c) => c.id === id)?.pinned;
      void ensureChatLoaded(id).then((chat) => {
        if (chat) dispatch({ type: 'CHAT_PATCH', id, patch: { pinned: !pinned } });
      });
    },
    [ensureChatLoaded],
  );

  const deleteChat = useCallback(
    (id: string) => {
      const g = genRef.current;
      if (g && g.chatId === id) stop();
      dispatch({ type: 'CHAT_DELETE', id });
      window.rico.chats.delete(id).catch(() => pushToast('error', tr('toast.generic')));
    },
    [pushToast, stop, tr],
  );

  const deleteAllChats = useCallback(async () => {
    if (genRef.current) stop();
    try {
      await window.rico.chats.deleteAll();
      dispatch({ type: 'CHATS_CLEAR' });
      pushToast('success', tr('toast.chatsDeleted'));
    } catch {
      pushToast('error', tr('toast.generic'));
    }
  }, [pushToast, stop, tr]);

  // ------------------------------------------------------------ persistence of dirty chats
  useEffect(() => {
    const ids = Object.keys(state.dirty);
    if (!ids.length) return;
    dispatch({ type: 'CLEAR_DIRTY', ids });
    const streamingAssistant = state.stream?.assistantId;
    for (const id of ids) {
      const chat = state.chats[id];
      if (!chat) continue;
      // never persist the half-written assistant message
      const messages = chat.messages.filter((m) => m.id !== streamingAssistant);
      window.rico.chats
        .save({ ...chat, messages })
        .catch(() => pushToast('error', tr('toast.saveFailed')));
    }
  }, [state.dirty, state.chats, state.stream, pushToast, tr]);

  // ------------------------------------------------------------ boot
  useEffect(() => {
    let cancelled = false;
    const api = window.rico;
    (async () => {
      const [settings, system, chatIndex, models, loadState] = await Promise.all([
        api.settings.get().catch(() => DEFAULT_SETTINGS),
        api.system.getInfo().catch(() => null),
        api.chats.list().catch(() => []),
        api.models.list().catch(() => [] as ModelEntry[]),
        api.models.getLoadState().catch(() => ({ state: 'idle' as const })),
      ]);
      if (!cancelled) {
        dispatch({ type: 'BOOTED', settings, system, chatIndex, models, loadState });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ------------------------------------------------------------ download events
  useEffect(() => {
    const off = window.rico.models.onProgress((p) => {
      dispatch({ type: 'DOWNLOAD', progress: p });
      if (p.status === 'done') {
        void (async () => {
          const list = await refreshModels();
          dispatch({ type: 'DOWNLOAD_CLEAR', modelId: p.modelId });
          const entry = list.find((m) => m.id === p.modelId);
          pushToast('success', tr('toast.downloadDone', { name: entry ? entry.name[stateRef.current.settings.uiLang] : p.modelId }));
          // main auto-activates the first model; only step in if nothing ended up active
          const ls = await refreshLoadState();
          if (ls.state === 'idle' && !list.some((m) => m.isActive)) await activateModel(p.modelId);
        })();
      } else if (p.status === 'error') {
        if (Date.now() - (lastDownloadError.current[p.modelId] ?? 0) > 3000) {
          lastDownloadError.current[p.modelId] = Date.now();
          pushToast('error', tr('toast.downloadFailed', { error: p.error ?? '' }));
        }
        void refreshModels();
      } else if (p.status === 'cancelled') {
        dispatch({ type: 'DOWNLOAD_CLEAR', modelId: p.modelId });
        void refreshModels();
      }
    });
    return off;
  }, [activateModel, pushToast, refreshLoadState, refreshModels, tr]);

  // ------------------------------------------------------------ engine load-state pushes
  useEffect(() => {
    return window.rico.models.onLoadState((loadState) => dispatch({ type: 'LOAD_STATE', loadState }));
  }, []);

  // ------------------------------------------------------------ actions object (stable)
  const actions = useMemo<Actions>(
    () => ({
      sendMessage,
      addImages,
      removeImage: (id) => dispatch({ type: 'ATTACH_REMOVE', id }),
      stop,
      regenerate,
      newChat,
      openChat,
      renameChat,
      togglePin,
      deleteChat,
      deleteAllChats,
      updateSettings,
      previewSettings,
      setSidebar: (open) => dispatch({ type: 'SIDEBAR', open }),
      toggleSidebar: () => dispatch({ type: 'SIDEBAR', open: !stateRef.current.sidebarOpen }),
      setSearch: (query) => dispatch({ type: 'SEARCH', query }),
      openSettings: (tab = 'general') => dispatch({ type: 'MODAL', modal: { type: 'settings', tab } }),
      closeModal: () => dispatch({ type: 'MODAL', modal: null }),
      openModelScreen,
      closeOnboarding: () => dispatch({ type: 'ONBOARDING', on: false }),
      refreshModels,
      downloadModel,
      cancelDownload,
      importModel,
      removeModel,
      activateModel,
      toast: pushToast,
      dismissToast: (id) => dispatch({ type: 'TOAST_REMOVE', id }),
    }),
    [
      sendMessage, addImages, stop, regenerate, newChat, openChat, renameChat, togglePin, deleteChat, deleteAllChats,
      updateSettings, previewSettings, openModelScreen, refreshModels, downloadModel, cancelDownload,
      importModel, removeModel, activateModel, pushToast,
    ],
  );

  return (
    <StateCtx.Provider value={state}>
      <ActionsCtx.Provider value={actions}>{children}</ActionsCtx.Provider>
    </StateCtx.Provider>
  );
}
