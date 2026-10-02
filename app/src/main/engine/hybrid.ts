// Router in front of the two backends:
//   llama-server sidecar  - preferred for everything when its binary is bundled (vision + text)
//   node-llama-cpp worker - hardware probing, and a TEXT-ONLY fallback when the sidecar cannot run
//                           (binary missing in a dev checkout, or blocked by the OS, e.g. Windows Smart App Control)
// Image input needs the sidecar: the node-llama-cpp release in use has no multimodal (mmproj) support.

import type { ModelLoadState } from '../../shared/api';
import { EngineError } from './errors';
import type { LoadedInfo, LoadParams, VisionIssue, WorkerHardware } from './protocol';
import type { Backend, Engine, GenerateHandlers, GenerateInput } from './types';

export interface SidecarBackend extends Backend {
  isAvailable(): boolean;
}

export class HybridEngine implements Engine {
  private active: Backend | undefined;
  private info: LoadedInfo | undefined;
  /** While a load is running, backend state events (e.g. the sidecar failing before the fallback) must not leak out. */
  private loadInFlight = false;
  /** The OS refused to run the sidecar (Windows Smart App Control, exit 0xC0E90002): do not relaunch it on every load / perf switch. */
  private sidecarBlocked = false;
  private state: ModelLoadState = { state: 'idle' };
  private listeners = new Set<(s: ModelLoadState) => void>();

  constructor(
    private readonly worker: Backend & { hardware(timeoutMs?: number): Promise<WorkerHardware> },
    private readonly sidecar: SidecarBackend | undefined,
    private readonly log?: (...args: unknown[]) => void
  ) {
    // A backend dying while it is the active one must surface as a load-state change.
    for (const b of [worker, sidecar]) {
      b?.onLoadState((s) => {
        if (!this.loadInFlight && this.active === b && (s.state === 'error' || s.state === 'idle')) {
          this.info = undefined;
          this.setState(s);
        }
      });
    }
  }

  hardware(timeoutMs?: number): Promise<WorkerHardware> {
    return this.worker.hardware(timeoutMs);
  }

  getLoadState(): ModelLoadState {
    return { ...this.state };
  }

  getLoadedInfo(): LoadedInfo | undefined {
    return this.info;
  }

  hasActiveGeneration(): boolean {
    return this.active?.hasActiveGeneration() ?? false;
  }

  onLoadState(cb: (s: ModelLoadState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private setState(next: ModelLoadState): void {
    this.state = next;
    for (const l of this.listeners) {
      try {
        l({ ...next });
      } catch (err) {
        this.log?.('load-state listener failed', err);
      }
    }
  }

  async load(modelId: string, params: LoadParams): Promise<LoadedInfo> {
    this.setState({ modelId, state: 'loading' });
    this.loadInFlight = true;
    try {
      const info = await this.loadInner(modelId, params);
      this.info = info;
      this.setState({ modelId, state: 'ready' });
      return info;
    } catch (err) {
      this.active = undefined;
      this.info = undefined;
      // A load superseded by unload()/another load() is not an error.
      if (!(err instanceof EngineError && err.code === 'cancelled')) {
        this.setState({ modelId, state: 'error', error: err instanceof Error ? err.message : String(err) });
      }
      throw err;
    } finally {
      this.loadInFlight = false;
    }
  }

  private async loadInner(modelId: string, params: LoadParams): Promise<LoadedInfo> {
    // Free whatever is currently loaded first: two multi-GB models must never coexist.
    // (active is cleared first so the old backend's "idle" event is not mistaken for the new model's state)
    this.active = undefined;
    this.info = undefined;
    await Promise.all([this.worker.unload().catch(() => undefined), this.sidecar?.unload().catch(() => undefined)]);
    this.active = undefined;
    this.info = undefined;

    let sidecarProblem: VisionIssue | undefined;
    if (this.sidecar?.isAvailable() && this.sidecarBlocked) {
      sidecarProblem = 'blocked';
    } else if (this.sidecar?.isAvailable()) {
      this.active = this.sidecar;
      try {
        const loaded = await this.sidecar.load(modelId, params);
        // The probe worker is no longer needed: do not let its Vulkan context hold VRAM next to the sidecar.
        void this.worker.release?.().catch(() => undefined);
        return loaded;
      } catch (err) {
        const fallbackable = err instanceof EngineError && (err.code === 'blocked' || err.code === 'crashed' || err.code === 'unavailable');
        if (!fallbackable) throw err;
        sidecarProblem = err.code === 'blocked' ? 'blocked' : err.code === 'unavailable' ? 'unavailable' : 'failed';
        if (err.code === 'blocked') this.sidecarBlocked = true; // remembered until the app restarts
        this.log?.('llama-server unavailable, falling back to node-llama-cpp (text only):', err.message);
      }
    } else {
      sidecarProblem = 'unavailable';
    }

    // Text-only fallback.
    this.active = this.worker;
    const info = await this.worker.load(modelId, { ...params, mmprojPath: undefined });
    const out: LoadedInfo = { ...info, vision: false, engine: 'node-llama-cpp' };
    if (params.mmprojPath) out.visionNote = sidecarProblem;
    return out;
  }

  async unload(): Promise<void> {
    await Promise.all([this.worker.unload().catch(() => undefined), this.sidecar?.unload().catch(() => undefined)]);
    this.active = undefined;
    this.info = undefined;
    this.setState({ state: 'idle' });
  }

  generate(requestId: string, req: GenerateInput, handlers: GenerateHandlers): void {
    if (!this.active) {
      handlers.onError({ message: 'No model is loaded', code: 'no-model' });
      return;
    }
    this.active.generate(requestId, req, handlers);
  }

  abort(requestId: string): void {
    this.active?.abort(requestId);
  }

  async shutdown(): Promise<void> {
    await Promise.all([this.worker.shutdown().catch(() => undefined), this.sidecar?.shutdown().catch(() => undefined)]);
  }
}
