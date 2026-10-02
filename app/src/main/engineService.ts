// Glue between settings, the model manager and the engine host:
//   - which model is active / loaded (reloads lazily when the model or performance mode changes)
//   - turning engine errors into localised messages

import { totalmem } from 'node:os';
import type { ModelLoadState, Settings, UiLang } from '../shared/api';
import { EngineError } from './engine/errors';
import type { Engine } from './engine/types';
import { msg, RicoError } from './messages';
import type { ModelManager } from './modelManager';
import type { SettingsStore } from './storage';

const GiB = 1024 ** 3;

export interface EngineServiceDeps {
  host: Engine;
  models: ModelManager;
  settings: SettingsStore;
  lang(): UiLang;
  log?: (...args: unknown[]) => void;
}

/** Maps any failure while loading/running the engine to a localised, user-facing Error. */
export function toUserError(err: unknown, lang: UiLang, fallbackKey: 'modelLoadFailed' | 'generateFailed' = 'modelLoadFailed'): Error {
  if (err instanceof RicoError) return err;
  if (err instanceof EngineError) {
    switch (err.code) {
      case 'oom':
        return new Error(msg('outOfMemory', lang));
      case 'bad-file':
        return new Error(msg('badModelFile', lang));
      case 'blocked':
        return new Error(msg('engineBlocked', lang));
      case 'crashed':
      case 'unavailable':
        return new Error(msg('engineCrashed', lang));
      case 'cancelled':
        return new Error(msg('loading', lang));
      default:
        return new Error(msg(fallbackKey, lang, err.message));
    }
  }
  return new Error(msg(fallbackKey, lang, err instanceof Error ? err.message : String(err)));
}

export class EngineService {
  private loadedKey: string | undefined;
  private loading: Promise<void> | undefined;

  constructor(private readonly deps: EngineServiceDeps) {
    // If the worker dies, whatever it had loaded is gone.
    deps.host.onLoadState((s) => {
      if (s.state === 'error' || s.state === 'idle') this.loadedKey = undefined;
    });
  }

  getLoadState(): ModelLoadState {
    return this.deps.host.getLoadState();
  }

  onLoadState(cb: (s: ModelLoadState) => void): () => void {
    return this.deps.host.onLoadState(cb);
  }

  private keyFor(modelId: string, s: Settings): string {
    return `${modelId}|${s.perfMode}`;
  }

  /** Makes sure the active model is loaded with the current performance mode; loads it if needed. */
  async ensureLoaded(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.loading) {
        await this.loading.catch(() => undefined);
      }
      const settings = await this.deps.settings.get();
      const lang = this.deps.lang();

      let activeId = settings.activeModelId;
      if (!activeId || !(await this.deps.models.isInstalled(activeId))) {
        // Fall back to any installed model so a first-time user is never stuck.
        const installed = await this.deps.models.installedIds();
        if (installed.length === 0) throw new RicoError('noModel', lang);
        activeId = installed[0]!;
        await this.deps.settings.set({ activeModelId: activeId });
      }

      const key = this.keyFor(activeId, settings);
      if (this.loadedKey === key && this.deps.host.getLoadState().state === 'ready') return;
      if (this.loading) continue; // someone else started a load in the meantime

      const target = await this.deps.models.resolveForLoad(activeId);
      if (!target) throw new RicoError('noModel', lang);

      const modelId = activeId;
      this.loading = (async () => {
        try {
          await this.deps.host.load(modelId, {
            modelPath: target.modelPath,
            perfMode: settings.perfMode,
            requestedContext: target.requestedContext,
            totalRamGB: totalmem() / GiB,
            modelSizeGB: target.sizeGB,
            chatTemplateHint: target.chatTemplateHint,
            mmprojPath: target.mmprojPath
          });
          this.loadedKey = key;
        } catch (err) {
          this.loadedKey = undefined;
          throw toUserError(err, lang);
        } finally {
          this.loading = undefined;
        }
      })();
      await this.loading;
      return;
    }
    // Other loads kept superseding ours: say so instead of silently pretending the model is ready.
    throw new RicoError('loading', this.deps.lang());
  }

  /** Persists the choice, then loads the model. Resolves once it is ready. */
  async setActive(modelId: string): Promise<void> {
    const lang = this.deps.lang();
    if (!(await this.deps.models.isInstalled(modelId))) throw new RicoError('notInstalled', lang);
    await this.deps.settings.set({ activeModelId: modelId });
    await this.ensureLoaded();
  }

  /** Background warm-up at startup; errors are surfaced through the load-state event, not thrown. */
  async preload(): Promise<void> {
    try {
      const settings = await this.deps.settings.get();
      if (!settings.activeModelId) return;
      if (!(await this.deps.models.isInstalled(settings.activeModelId))) return;
      await this.ensureLoaded();
    } catch (err) {
      this.deps.log?.('preload failed', err);
    }
  }

  /** Called when a model is being deleted: frees the engine if it holds that model. */
  async releaseIfLoaded(modelId: string): Promise<void> {
    const state = this.deps.host.getLoadState();
    if (state.modelId === modelId && state.state !== 'idle') {
      await this.deps.host.unload();
      this.loadedKey = undefined;
    }
    const settings = await this.deps.settings.get();
    if (settings.activeModelId === modelId) await this.deps.settings.set({ activeModelId: undefined });
  }
}
