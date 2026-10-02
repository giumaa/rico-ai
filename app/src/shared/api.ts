// IPC contract between main (Agent A) and renderer (Agent B).
// Exposed in the renderer as `window.rico` via contextBridge.

export type ThemePref = 'system' | 'dark' | 'light';
export type UiLang = 'ar' | 'en';
export type PerfMode = 'eco' | 'balanced' | 'max';
export type Role = 'user' | 'assistant' | 'system';

export interface SystemInfo {
  platform: NodeJS.Platform;
  arch: string;
  totalRamGB: number;
  freeRamGB: number;
  cpuModel: string;
  physicalCores: number;
  gpu: {
    type: 'cuda' | 'vulkan' | 'metal' | 'none';
    name?: string;
    vramGB?: number;
    /** true for integrated GPUs / Apple Silicon that share system RAM (added by Agent A, optional). */
    unified?: boolean;
  };
  recommendedModelId: string;
  appVersion: string;
}

export interface ModelEntry {
  id: string;                 // e.g. 'rico-lite'
  name: { ar: string; en: string };
  description: { ar: string; en: string };
  sizeGB: number;
  minRamGB: number;
  contextLength: number;
  status: 'not-installed' | 'downloading' | 'installed' | 'error';
  progress?: number;          // 0..1 while downloading
  isActive: boolean;
  source: 'catalog' | 'imported';
  /** true when the model (with its mmproj projector) can see images. */
  supportsVision?: boolean;
  /**
   * Max images main accepts in ONE user message with this model on this machine (0 = text only). It shrinks on
   * small-RAM machines because every image costs ~1000 tokens of a small context window. Main rejects more
   * with a clear error; the renderer should disable attaching beyond it (added by Agent A).
   */
  maxImages?: number;
  /** Long edge in px the renderer should downscale images to for this model/device (added by Agent A). */
  maxImageEdge?: number;
  /** Installed, but the catalog now describes different bytes (same file names): offer "update" (added by Agent A). */
  updateAvailable?: boolean;
  /** Human-readable reason when status === 'error' (added by Agent A, optional). */
  error?: string;
}

export interface DownloadProgress {
  modelId: string;
  receivedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  status: 'downloading' | 'verifying' | 'done' | 'error' | 'cancelled';
  error?: string;
}

/** Image attached by the user. The renderer downsizes to ≤1280px on the long edge before sending. */
export interface ImageAttachment {
  id: string;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  dataBase64: string;          // no "data:" prefix
  name?: string;
  width?: number;
  height?: number;
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  images?: ImageAttachment[];  // user messages only
}

export interface Chat {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
}

export interface ChatSummary { id: string; title: string; updatedAt: number; pinned?: boolean }

export interface Settings {
  theme: ThemePref;
  uiLang: UiLang;
  perfMode: PerfMode;
  temperature: number;        // default 0.7
  maxTokens: number;          // default 1024
  dialect: 'libyan' | 'msa' | 'auto'; // default 'libyan'
  fontScale: number;          // default 1.0
  activeModelId?: string;
}

export interface GenerateRequest {
  chatId: string;
  messages: Pick<ChatMessage, 'role' | 'content' | 'images'>[]; // full visible history (no system prompt; main injects persona)
}

export interface TokenEvent { requestId: string; chunk: string }
export interface DoneEvent { requestId: string; text: string; tokensPerSecond?: number; stopped?: boolean }
export interface ErrorEvent { requestId: string; message: string }

export interface ModelLoadState {
  modelId?: string;
  state: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
}

export type Unsubscribe = () => void;

export interface RicoAPI {
  system: {
    getInfo(): Promise<SystemInfo>;
    /** Absolute path of the folder holding chats/settings/models (added by Agent A). */
    getDataPath(): Promise<string>;
    /** Opens the data folder in the OS file manager (local only; added by Agent A). */
    openDataFolder(): Promise<void>;
  };
  /** Native window chrome helpers (added by Agent A). */
  window: {
    /**
     * Tells main which theme the UI is actually showing so the native title-bar overlay
     * (Windows) / window background / native menus match. `theme` is the RESOLVED theme.
     */
    setTitleBarTheme(theme: 'dark' | 'light'): Promise<void>;
  };
  models: {
    list(): Promise<ModelEntry[]>;
    /**
     * Starts a download and resolves when it has FINISHED (or was cancelled); rejects on error.
     * Progress/terminal status is also pushed through onProgress. Rejects immediately if the
     * model is unknown, already downloading, or there is not enough free disk space.
     * When no model is active yet, a freshly downloaded model becomes active automatically.
     */
    download(modelId: string): Promise<void>;
    cancelDownload(modelId: string): Promise<void>;
    onProgress(cb: (p: DownloadProgress) => void): Unsubscribe;
    importFile(): Promise<ModelEntry | null>;   // opens native file dialog for .gguf (null = cancelled)
    remove(modelId: string): Promise<void>;
    /** Persists the choice and loads the model in the engine; resolves once it is ready. */
    setActive(modelId: string): Promise<void>;
    getLoadState(): Promise<ModelLoadState>;
    /** Push notifications for engine load-state changes (added by Agent A). */
    onLoadState(cb: (s: ModelLoadState) => void): Unsubscribe;
  };
  chat: {
    generate(req: GenerateRequest): Promise<{ requestId: string }>;
    stop(requestId: string): Promise<void>;
    onToken(cb: (e: TokenEvent) => void): Unsubscribe;
    onDone(cb: (e: DoneEvent) => void): Unsubscribe;
    onError(cb: (e: ErrorEvent) => void): Unsubscribe;
  };
  chats: {
    list(): Promise<ChatSummary[]>;
    get(id: string): Promise<Chat | null>;
    save(chat: Chat): Promise<void>;
    delete(id: string): Promise<void>;
    deleteAll(): Promise<void>;
  };
  settings: {
    get(): Promise<Settings>;
    set(patch: Partial<Settings>): Promise<Settings>;
  };
}

declare global {
  interface Window { rico: RicoAPI }
}
