// Sandboxed preload: exposes the typed `window.rico` API (src/shared/api.ts) through contextBridge.
// Only whitelisted channels are reachable; the raw ipcRenderer / event objects never leak to the page.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  Chat,
  DoneEvent,
  DownloadProgress,
  ErrorEvent,
  GenerateRequest,
  ModelLoadState,
  RicoAPI,
  Settings,
  TokenEvent,
  Unsubscribe
} from '../shared/api';
import { IPC } from '../shared/ipc';

/** ipcRenderer.invoke wraps failures as "Error invoking remote method 'x': Error: msg" — keep only msg. */
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(raw.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, ''));
  }
}

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: RicoAPI = {
  system: {
    getInfo: () => call(IPC.systemGetInfo),
    getDataPath: () => call(IPC.systemGetDataPath),
    openDataFolder: () => call(IPC.systemOpenDataFolder)
  },
  window: {
    setTitleBarTheme: (theme: 'dark' | 'light') => call(IPC.windowSetTitleBarTheme, theme)
  },
  models: {
    list: () => call(IPC.modelsList),
    download: (modelId: string) => call(IPC.modelsDownload, modelId),
    cancelDownload: (modelId: string) => call(IPC.modelsCancelDownload, modelId),
    onProgress: (cb: (p: DownloadProgress) => void) => subscribe(IPC.evModelsProgress, cb),
    importFile: () => call(IPC.modelsImportFile),
    remove: (modelId: string) => call(IPC.modelsRemove, modelId),
    setActive: (modelId: string) => call(IPC.modelsSetActive, modelId),
    getLoadState: () => call(IPC.modelsGetLoadState),
    onLoadState: (cb: (s: ModelLoadState) => void) => subscribe(IPC.evModelsLoadState, cb)
  },
  chat: {
    generate: (req: GenerateRequest) => call(IPC.chatGenerate, req),
    stop: (requestId: string) => call(IPC.chatStop, requestId),
    onToken: (cb: (e: TokenEvent) => void) => subscribe(IPC.evChatToken, cb),
    onDone: (cb: (e: DoneEvent) => void) => subscribe(IPC.evChatDone, cb),
    onError: (cb: (e: ErrorEvent) => void) => subscribe(IPC.evChatError, cb)
  },
  chats: {
    list: () => call(IPC.chatsList),
    get: (id: string) => call(IPC.chatsGet, id),
    save: (chat: Chat) => call(IPC.chatsSave, chat),
    delete: (id: string) => call(IPC.chatsDelete, id),
    deleteAll: () => call(IPC.chatsDeleteAll)
  },
  settings: {
    get: () => call(IPC.settingsGet),
    set: (patch: Partial<Settings>) => call(IPC.settingsSet, patch)
  }
};

contextBridge.exposeInMainWorld('rico', api);
