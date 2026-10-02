// ipcMain handlers: the main-process half of window.rico (see src/shared/api.ts and src/preload/index.ts).

import { app, BrowserWindow, ipcMain, nativeTheme, shell, type IpcMainInvokeEvent } from 'electron';
import type { ChatStore, SettingsStore } from './storage';
import type { Chat, GenerateRequest, ModelEntry, Settings, SystemInfo } from '../shared/api';
import { IPC } from '../shared/ipc';
import type { Catalog } from './catalog';
import type { ChatController } from './chat';
import type { Engine } from './engine/types';
import type { EngineService } from './engineService';
import { buildSystemInfo } from './hardware';
import type { ModelManager } from './modelManager';
import { isTrustedSenderUrl, type PolicyOptions } from './securityPolicy';
import { applyTitleBarTheme } from './window';

export interface IpcDeps {
  policy: PolicyOptions;
  host: Engine;
  engine: EngineService;
  models: ModelManager;
  chat: ChatController;
  chats: ChatStore;
  settings: SettingsStore;
  loadCatalog: () => Promise<Catalog>;
  dataRoot: string;
  /** Called after settings changed so main can refresh cached values (UI language). */
  onSettingsChanged(next: Settings, prev: Settings): void;
  log?: (...args: unknown[]) => void;
}

function str(v: unknown, what: string, max = 200): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new Error(`Invalid ${what}`);
  return v;
}

export function registerIpc(d: IpcDeps): void {
  const trusted = (e: IpcMainInvokeEvent): void => {
    if (!isTrustedSenderUrl(e.senderFrame?.url, d.policy)) throw new Error('Untrusted IPC sender');
  };
  /** ipcMain.handle with a sender check on every call. */
  const handle = <A extends unknown[], R>(channel: string, fn: (e: IpcMainInvokeEvent, ...args: A) => R | Promise<R>): void => {
    ipcMain.handle(channel, async (e, ...args) => {
      trusted(e);
      return fn(e, ...(args as A));
    });
  };

  // ---- system / window
  handle(IPC.systemGetInfo, async (): Promise<SystemInfo> => {
    const [hw, catalog] = await Promise.all([d.host.hardware().catch(() => null), d.loadCatalog()]);
    return buildSystemInfo({ hw, catalog, appVersion: app.getVersion() });
  });
  handle(IPC.systemGetDataPath, () => d.dataRoot);
  handle(IPC.systemOpenDataFolder, async () => {
    await shell.openPath(d.dataRoot);
  });
  handle(IPC.windowSetTitleBarTheme, (e, theme: unknown) => {
    if (theme !== 'dark' && theme !== 'light') throw new Error('Invalid theme');
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) applyTitleBarTheme(win, theme);
  });

  // ---- models
  handle(IPC.modelsList, (): Promise<ModelEntry[]> => d.models.list());
  handle(IPC.modelsDownload, async (_e, modelId: unknown) => {
    const id = str(modelId, 'model id');
    // Updating a model that is currently loaded: release its files first (Windows cannot replace a mapped file).
    const state = d.host.getLoadState();
    if (state.modelId === id && state.state !== 'idle' && (await d.models.hasUpdate(id))) {
      await d.chat.stopAll();
      await d.host.unload();
    }
    await d.models.download(id);
    await activateIfFirst(id);
  });
  handle(IPC.modelsCancelDownload, (_e, modelId: unknown) => {
    d.models.cancelDownload(str(modelId, 'model id'));
  });
  handle(IPC.modelsImportFile, async (): Promise<ModelEntry | null> => {
    const entry = await d.models.importFile();
    if (entry) await activateIfFirst(entry.id);
    return entry;
  });
  handle(IPC.modelsRemove, async (_e, modelId: unknown) => {
    const id = str(modelId, 'model id');
    const state = d.host.getLoadState();
    if (state.modelId === id) await d.chat.stopAll();
    await d.engine.releaseIfLoaded(id);
    await d.models.remove(id);
  });
  handle(IPC.modelsSetActive, async (_e, modelId: unknown) => {
    await d.chat.stopAll();
    await d.engine.setActive(str(modelId, 'model id'));
  });
  handle(IPC.modelsGetLoadState, () => d.engine.getLoadState());

  // ---- chat
  handle(IPC.chatGenerate, (e, req: GenerateRequest) => d.chat.generate(e.sender, req));
  handle(IPC.chatStop, (_e, requestId: unknown) => {
    d.chat.stop(str(requestId, 'request id', 100));
  });

  // ---- chats
  handle(IPC.chatsList, () => d.chats.list());
  handle(IPC.chatsGet, (_e, id: unknown) => d.chats.get(str(id, 'chat id', 100)));
  handle(IPC.chatsSave, (_e, chat: Chat) => d.chats.save(chat));
  handle(IPC.chatsDelete, (_e, id: unknown) => d.chats.delete(str(id, 'chat id', 100)));
  handle(IPC.chatsDeleteAll, () => d.chats.deleteAll());

  // ---- settings
  handle(IPC.settingsGet, () => d.settings.get());
  handle(IPC.settingsSet, async (_e, patch: Partial<Settings>) => {
    const prev = await d.settings.get();
    const next = await d.settings.set(patch && typeof patch === 'object' ? patch : {});
    if (next.theme !== prev.theme) {
      nativeTheme.themeSource = next.theme;
    }
    d.onSettingsChanged(next, prev);
    // A different performance mode applies lazily: ensureLoaded() reloads the model on the next generate() (never
    // mid-generation, never a surprise multi-GB reload while the user is just browsing settings).
    return next;
  });

  async function activateIfFirst(modelId: string): Promise<void> {
    const s = await d.settings.get();
    if (!s.activeModelId && (await d.models.isInstalled(modelId))) {
      void d.engine.setActive(modelId).catch((err) => d.log?.('auto-activate failed', err));
    }
  }
}

/** Broadcasts a push event to every open window. */
export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  }
}

