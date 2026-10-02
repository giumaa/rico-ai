// Rico — main process entry.
// Privacy contract: no telemetry, no auto-update, no crash-report upload, no network from Chromium.
// The only outbound traffic in the whole app is a model download that the user starts (downloader.ts).

import { app, BrowserWindow, dialog, Menu, session } from 'electron';
import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { UiLang } from '../shared/api';
import { IPC } from '../shared/ipc';
import { parseCatalog, type Catalog } from './catalog';
import { ChatController } from './chat';
import { EngineHost } from './engine/host';
import { HybridEngine } from './engine/hybrid';
import { ServerEngine } from './engine/serverEngine';
import { serverBinaryCandidates } from './engine/serverCore';
import { EngineService } from './engineService';
import { registerIpc, broadcast } from './ipc';
import { ModelManager } from './modelManager';
import { catalogPath, dataPaths, engineBinRoot, engineWorkerPath, isDev, personaDir, rendererRoot } from './paths';
import { applyPrivacySwitches, hardenWebContents, installRendererProtocol, lockDownSession, registerAppScheme } from './security';
import { APP_ORIGIN, type PolicyOptions } from './securityPolicy';
import { runSmokeTest } from './smoke';
import { killStaleSidecar } from './staleProcess';
import { ChatStore, readJsonOr, SettingsStore } from './storage';
import { applyTitleBarTheme, createMainWindow, resolveTheme } from './window';

const devOrigin = isDev() ? process.env.ELECTRON_RENDERER_URL : undefined;
const policy: PolicyOptions = { devOrigin };

function log(...args: unknown[]): void {
  console.log('[rico]', ...args);
}

// ---- must happen before 'ready' ----------------------------------------------------------------------------
registerAppScheme();
applyPrivacySwitches(policy);
app.setName('Rico');
// No crashReporter.start(), no autoUpdater: nothing is ever uploaded or checked.

process.on('uncaughtException', (err) => console.error('[rico] uncaughtException', err));
process.on('unhandledRejection', (err) => console.error('[rico] unhandledRejection', err));

let mainWindow: BrowserWindow | undefined;

async function loadCatalogFromDisk(): Promise<Catalog> {
  const raw = await readJsonOr<unknown>(catalogPath(), null);
  return parseCatalog(raw);
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  if (process.platform === 'win32') app.setAppUserModelId('com.juma.rico');

  const paths = dataPaths();
  await fs.mkdir(paths.models, { recursive: true });
  await fs.mkdir(paths.chats, { recursive: true });

  const settings = new SettingsStore(paths.settings);
  let current = await settings.get();
  let lang: UiLang = current.uiLang;

  // ---- lock everything down -------------------------------------------------------------------------------
  lockDownSession(session.defaultSession, policy);
  app.on('web-contents-created', (_e, contents) => hardenWebContents(contents, policy));
  installRendererProtocol(rendererRoot());

  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { role: 'windowMenu' }
      ])
    );
  } else {
    Menu.setApplicationMenu(null);
  }

  // ---- services -------------------------------------------------------------------------------------------
  // Two backends behind one interface: the llama-server sidecar (vision + text) and node-llama-cpp (hardware probe +
  // text-only fallback). See engine/hybrid.ts.
  const pidFile = join(paths.root, 'engine.pid');
  await killStaleSidecar(pidFile).catch(() => false);
  const worker = new EngineHost({ workerPath: engineWorkerPath(), log });
  const binRoot = engineBinRoot();
  const sidecar = new ServerEngine({
    binaries: (preferCpu) => {
      const override = process.env.RICO_LLAMA_SERVER;
      if (override) return existsSync(override) ? [override] : [];
      return serverBinaryCandidates(process.platform, process.arch, preferCpu)
        .map((rel) => join(binRoot, rel))
        .filter((p) => existsSync(p));
    },
    hardware: () => worker.hardware().catch(() => null),
    pidFile,
    log
  });
  const host = new HybridEngine(worker, sidecar, log);
  const models = new ModelManager({
    modelsDir: paths.models,
    loadCatalog: loadCatalogFromDisk,
    getSettings: () => settings.get(),
    emitProgress: (p) => broadcast(IPC.evModelsProgress, p),
    lang: () => lang,
    pickModelFile: async () => {
      const opts: Electron.OpenDialogOptions = {
        title: lang === 'ar' ? 'اختار ملف النموذج (GGUF)' : 'Choose a model file (GGUF)',
        properties: ['openFile'],
        filters: [{ name: 'GGUF', extensions: ['gguf'] }]
      };
      const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]!;
    }
  });
  const engine = new EngineService({ host, models, settings, lang: () => lang, log });
  const chat = new ChatController({ host, engine, settings, personaDir: personaDir(), lang: () => lang, log });
  const chats = new ChatStore(paths.chats);

  engine.onLoadState((s) => broadcast(IPC.evModelsLoadState, s));

  registerIpc({
    policy,
    host,
    engine,
    models,
    chat,
    chats,
    settings,
    loadCatalog: loadCatalogFromDisk,
    dataRoot: paths.root,
    onSettingsChanged: (next) => {
      current = next;
      lang = next.uiLang;
    },
    log
  });

  // ---- window ---------------------------------------------------------------------------------------------
  const openWindow = (): BrowserWindow => {
    const theme = resolveTheme(current.theme);
    const win = createMainWindow({ theme, startUrl: devOrigin ?? `${APP_ORIGIN}/index.html` });
    applyTitleBarTheme(win, theme);
    win.on('closed', () => {
      if (mainWindow === win) mainWindow = undefined;
    });
    mainWindow = win;
    return win;
  };

  const win = openWindow();
  if (process.env.RICO_SMOKE_TEST === '1') runSmokeTest(win);
  else setTimeout(() => void engine.preload(), 1500); // warm the active model in the background

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow();
  });
  // A loaded model is gigabytes of RAM: closing the window quits the app on every platform.
  app.on('window-all-closed', () => app.quit());

  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    const force = setTimeout(() => app.exit(0), 4000);
    chat
      .stopAll()
      .catch(() => undefined)
      .then(() => host.shutdown())
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(force);
        app.exit(0);
      });
  });
}

if (!app.requestSingleInstanceLock()) {
  // A second copy would load a second multi-GB model: hand over to the running one instead.
  app.quit();
} else {
  bootstrap().catch((err) => {
    console.error('[rico] fatal startup error', err);
    dialog.showErrorBox('Rico', String(err instanceof Error ? err.message : err));
    app.exit(1);
  });
}
