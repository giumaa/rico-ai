import type {
  Chat,
  ChatSummary,
  DownloadProgress,
  ImageAttachment,
  ModelEntry,
  ModelLoadState,
  Settings,
  SystemInfo,
} from '@shared/api';

export type SettingsTab = 'general' | 'performance' | 'models' | 'data' | 'about';

export type ModalState = null | { type: 'settings'; tab: SettingsTab };

/** loading-model: waking the engine · thinking: waiting for first token · streaming: tokens flowing */
export type StreamPhase = 'loading-model' | 'thinking' | 'streaming';

export interface StreamState {
  chatId: string;
  assistantId: string;
  phase: StreamPhase;
}

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: string;
  kind: ToastKind;
  text: string;
  action?: ToastAction;
}

export type LoadState = ModelLoadState;

/** DownloadProgress plus a smoothed speed so the ETA does not jitter. */
export interface DownloadView extends DownloadProgress {
  smoothBps: number;
}

export interface ChatError {
  chatId: string;
  message: string;
}

export interface AppState {
  booted: boolean;
  settings: Settings;
  system: SystemInfo | null;

  chatIndex: ChatSummary[];
  /** full chats that have been loaded (cache) */
  chats: Record<string, Chat>;
  /** null = fresh "new chat" screen (nothing persisted until the first message) */
  activeChatId: string | null;
  /** chats whose changes still have to be persisted via window.rico.chats.save */
  dirty: Record<string, true>;
  stream: StreamState | null;
  chatError: ChatError | null;

  sidebarOpen: boolean;
  search: string;
  modal: ModalState;
  onboarding: boolean;

  models: ModelEntry[];
  modelsLoaded: boolean;
  loadState: LoadState;
  downloads: Record<string, DownloadView>;

  toasts: Toast[];

  /** images staged in the composer for the next message */
  attachments: ImageAttachment[];
  /** images still being downscaled */
  pendingImages: number;
}
