// File-system locations (dev vs packaged). Only this module knows the difference.

import { app } from 'electron';
import { join, resolve } from 'node:path';

export function isDev(): boolean {
  return !app.isPackaged;
}

/** Folder holding package.json (dev) or app.asar (packaged). */
export function appRoot(): string {
  return app.getAppPath();
}

/** extraResources live next to the asar in production; in dev we read straight from the repo. */
function resourcePath(...parts: string[]): string {
  return app.isPackaged ? join(process.resourcesPath, ...parts) : join(appRoot(), 'resources', ...parts);
}

export function personaDir(): string {
  return resourcePath('persona');
}

export function catalogPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'catalog.json') : resolve(appRoot(), '..', 'models', 'catalog.json');
}

/** Output folders of electron-vite: out/main (this bundle), out/preload, out/renderer. */
export function rendererRoot(): string {
  return join(__dirname, '..', 'renderer');
}

export function preloadPath(): string {
  return join(__dirname, '..', 'preload', 'index.js');
}

export function engineWorkerPath(): string {
  return join(__dirname, 'engineWorker.js');
}

/** Root of the bundled llama-server builds: <resources>/bin (packaged) or app/resources/bin (dev, see scripts/fetch-llama-server.mjs). */
export function engineBinRoot(): string {
  return resourcePath('bin');
}

export function iconPath(): string | undefined {
  // Only needed for the Linux/Windows window icon in dev; packaged apps embed their icon.
  return app.isPackaged ? undefined : join(appRoot(), 'resources', 'icons', 'icon.png');
}

export function dataPaths(): { root: string; models: string; chats: string; settings: string } {
  const root = app.getPath('userData');
  return {
    root,
    models: join(root, 'models'),
    chats: join(root, 'chats'),
    settings: join(root, 'settings.json')
  };
}
