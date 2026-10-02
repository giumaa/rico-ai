import type {
  Chat,
  ChatMessage,
  ChatSummary,
  DownloadProgress,
  ImageAttachment,
  ModelEntry,
  Settings,
  SystemInfo,
} from '@shared/api';
import type {
  AppState,
  LoadState,
  ModalState,
  StreamPhase,
  Toast,
} from './types';

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  uiLang: 'ar',
  perfMode: 'eco',
  temperature: 0.7,
  maxTokens: 1024,
  dialect: 'libyan',
  fontScale: 1,
};

export const initialState: AppState = {
  booted: false,
  settings: DEFAULT_SETTINGS,
  system: null,
  chatIndex: [],
  chats: {},
  activeChatId: null,
  dirty: {},
  stream: null,
  chatError: null,
  sidebarOpen: true,
  search: '',
  modal: null,
  onboarding: false,
  models: [],
  modelsLoaded: false,
  loadState: { state: 'idle' },
  downloads: {},
  toasts: [],
  attachments: [],
  pendingImages: 0,
};

export type Action =
  | {
      type: 'BOOTED';
      settings: Settings;
      chatIndex: ChatSummary[];
      models: ModelEntry[];
      loadState: LoadState;
    }
  | { type: 'SYSTEM'; system: SystemInfo | null }
  | { type: 'SETTINGS'; settings: Settings }
  | { type: 'SETTINGS_PATCH'; patch: Partial<Settings> }
  | { type: 'CHAT_LOADED'; chat: Chat }
  | { type: 'CHAT_OPEN'; id: string | null }
  | {
      type: 'TURN_START';
      chatId: string;
      title: string;
      userMsg: ChatMessage;
      assistantMsg: ChatMessage;
      now: number;
    }
  | { type: 'TURN_RESTART'; chatId: string; assistantMsg: ChatMessage; now: number }
  | { type: 'STREAM_PHASE'; phase: StreamPhase }
  | { type: 'STREAM_CHUNK'; chatId: string; messageId: string; text: string }
  | { type: 'TURN_END'; chatId: string; messageId: string; text?: string }
  | { type: 'TURN_ERROR'; chatId: string; messageId: string; message: string }
  | { type: 'CLEAR_ERROR' }
  | { type: 'CHAT_PATCH'; id: string; patch: Partial<Pick<Chat, 'title' | 'pinned'>> }
  | { type: 'CHAT_DELETE'; id: string }
  | { type: 'CHATS_CLEAR' }
  | { type: 'CLEAR_DIRTY'; ids: string[] }
  | { type: 'SIDEBAR'; open: boolean }
  | { type: 'SEARCH'; query: string }
  | { type: 'MODAL'; modal: ModalState }
  | { type: 'ONBOARDING'; on: boolean }
  | { type: 'MODELS'; models: ModelEntry[] }
  | { type: 'LOAD_STATE'; loadState: LoadState }
  | { type: 'DOWNLOAD'; progress: DownloadProgress }
  | { type: 'DOWNLOAD_CLEAR'; modelId: string }
  | { type: 'TOAST_PUSH'; toast: Toast }
  | { type: 'TOAST_REMOVE'; id: string }
  | { type: 'ATTACH_ADD'; images: ImageAttachment[]; max: number }
  | { type: 'ATTACH_REMOVE'; id: string }
  | { type: 'ATTACH_CLEAR' }
  | { type: 'ATTACH_PENDING'; delta: number };

const summarize = (c: Chat): ChatSummary => ({
  id: c.id,
  title: c.title,
  updatedAt: c.updatedAt,
  pinned: c.pinned,
});

function upsertIndex(index: ChatSummary[], s: ChatSummary): ChatSummary[] {
  const i = index.findIndex((x) => x.id === s.id);
  if (i < 0) return [s, ...index];
  const next = index.slice();
  next[i] = s;
  return next;
}

function withChat(state: AppState, chat: Chat, markDirty: boolean): AppState {
  return {
    ...state,
    chats: { ...state.chats, [chat.id]: chat },
    chatIndex: upsertIndex(state.chatIndex, summarize(chat)),
    dirty: markDirty ? { ...state.dirty, [chat.id]: true } : state.dirty,
  };
}

function mapMessage(
  chat: Chat,
  messageId: string,
  fn: (m: ChatMessage) => ChatMessage,
): Chat {
  return { ...chat, messages: chat.messages.map((m) => (m.id === messageId ? fn(m) : m)) };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'BOOTED':
      return {
        ...state,
        booted: true,
        settings: { ...DEFAULT_SETTINGS, ...action.settings },
        chatIndex: action.chatIndex,
        models: action.models,
        modelsLoaded: true,
        loadState: action.loadState,
        onboarding: !action.models.some((m) => m.status === 'installed'),
      };

    case 'SYSTEM':
      return { ...state, system: action.system };
    case 'SETTINGS':
      return { ...state, settings: { ...state.settings, ...action.settings } };
    case 'SETTINGS_PATCH':
      return { ...state, settings: { ...state.settings, ...action.patch } };

    case 'CHAT_LOADED': {
      const existing = state.chats[action.chat.id];
      // never clobber a chat that is mid-generation with a stale copy from disk
      if (existing && state.stream?.chatId === action.chat.id) return state;
      return { ...state, chats: { ...state.chats, [action.chat.id]: action.chat } };
    }
    case 'CHAT_OPEN':
      return { ...state, activeChatId: action.id, chatError: null };

    case 'TURN_START': {
      const existing = state.chats[action.chatId];
      const chat: Chat = existing
        ? {
            ...existing,
            messages: [...existing.messages, action.userMsg, action.assistantMsg],
            updatedAt: action.now,
          }
        : {
            id: action.chatId,
            title: action.title,
            messages: [action.userMsg, action.assistantMsg],
            createdAt: action.now,
            updatedAt: action.now,
          };
      return {
        ...withChat(state, chat, true),
        activeChatId: action.chatId,
        stream: { chatId: action.chatId, assistantId: action.assistantMsg.id, phase: 'thinking' },
        chatError: null,
      };
    }

    case 'TURN_RESTART': {
      const existing = state.chats[action.chatId];
      if (!existing) return state;
      const last = existing.messages[existing.messages.length - 1];
      const base = last && last.role === 'assistant' ? existing.messages.slice(0, -1) : existing.messages;
      const chat: Chat = {
        ...existing,
        messages: [...base, action.assistantMsg],
        updatedAt: action.now,
      };
      return {
        ...withChat(state, chat, false),
        stream: { chatId: action.chatId, assistantId: action.assistantMsg.id, phase: 'thinking' },
        chatError: null,
      };
    }

    case 'STREAM_PHASE':
      return state.stream ? { ...state, stream: { ...state.stream, phase: action.phase } } : state;

    case 'STREAM_CHUNK': {
      const chat = state.chats[action.chatId];
      if (!chat) return state;
      const next = mapMessage(chat, action.messageId, (m) => ({
        ...m,
        content: m.content + action.text,
      }));
      // streaming updates must not touch the persisted index / dirty set
      return { ...state, chats: { ...state.chats, [chat.id]: next } };
    }

    case 'TURN_END': {
      const chat = state.chats[action.chatId];
      const cleared: AppState = { ...state, stream: null };
      if (!chat) return cleared;
      const msg = chat.messages.find((m) => m.id === action.messageId);
      const finalText = action.text ?? msg?.content ?? '';
      let messages: ChatMessage[];
      if (!finalText.trim()) {
        messages = chat.messages.filter((m) => m.id !== action.messageId);
      } else {
        messages = chat.messages.map((m) =>
          m.id === action.messageId ? { ...m, content: finalText } : m,
        );
      }
      return withChat(cleared, { ...chat, messages, updatedAt: Date.now() }, true);
    }

    case 'TURN_ERROR': {
      const chat = state.chats[action.chatId];
      const cleared: AppState = {
        ...state,
        stream: null,
        chatError: { chatId: action.chatId, message: action.message },
      };
      if (!chat) return cleared;
      const msg = chat.messages.find((m) => m.id === action.messageId);
      const keep = !!msg && msg.content.trim().length > 0;
      const messages = keep ? chat.messages : chat.messages.filter((m) => m.id !== action.messageId);
      return withChat(cleared, { ...chat, messages }, true);
    }

    case 'CLEAR_ERROR':
      return state.chatError ? { ...state, chatError: null } : state;

    case 'CHAT_PATCH': {
      const chat = state.chats[action.id];
      if (!chat) {
        // not cached: only the index is known (summary level patch)
        return {
          ...state,
          chatIndex: state.chatIndex.map((s) => (s.id === action.id ? { ...s, ...action.patch } : s)),
        };
      }
      return withChat(state, { ...chat, ...action.patch }, true);
    }

    case 'CHAT_DELETE': {
      const { [action.id]: _removed, ...chats } = state.chats;
      const { [action.id]: _d, ...dirty } = state.dirty;
      void _removed;
      void _d;
      return {
        ...state,
        chats,
        dirty,
        chatIndex: state.chatIndex.filter((s) => s.id !== action.id),
        activeChatId: state.activeChatId === action.id ? null : state.activeChatId,
        chatError: state.chatError?.chatId === action.id ? null : state.chatError,
      };
    }

    case 'CHATS_CLEAR':
      return { ...state, chats: {}, chatIndex: [], dirty: {}, activeChatId: null, chatError: null };

    case 'CLEAR_DIRTY': {
      const dirty = { ...state.dirty };
      for (const id of action.ids) delete dirty[id];
      return { ...state, dirty };
    }

    case 'SIDEBAR':
      return { ...state, sidebarOpen: action.open };
    case 'SEARCH':
      return { ...state, search: action.query };
    case 'MODAL':
      return { ...state, modal: action.modal };
    case 'ONBOARDING':
      return { ...state, onboarding: action.on };

    case 'MODELS':
      return { ...state, models: action.models, modelsLoaded: true };
    case 'LOAD_STATE':
      return { ...state, loadState: action.loadState };

    case 'DOWNLOAD': {
      const p = action.progress;
      const prev = state.downloads[p.modelId];
      const smooth =
        prev && prev.smoothBps > 0 ? prev.smoothBps * 0.8 + p.bytesPerSecond * 0.2 : p.bytesPerSecond;
      return {
        ...state,
        downloads: { ...state.downloads, [p.modelId]: { ...p, smoothBps: smooth } },
      };
    }
    case 'DOWNLOAD_CLEAR': {
      const { [action.modelId]: _gone, ...downloads } = state.downloads;
      void _gone;
      return { ...state, downloads };
    }

    case 'TOAST_PUSH':
      return { ...state, toasts: [...state.toasts.slice(-3), action.toast] };
    case 'TOAST_REMOVE':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };

    case 'ATTACH_ADD':
      return { ...state, attachments: [...state.attachments, ...action.images].slice(0, action.max) };
    case 'ATTACH_REMOVE':
      return { ...state, attachments: state.attachments.filter((a) => a.id !== action.id) };
    case 'ATTACH_CLEAR':
      return state.attachments.length ? { ...state, attachments: [] } : state;
    case 'ATTACH_PENDING':
      return { ...state, pendingImages: Math.max(0, state.pendingImages + action.delta) };
  }
}
