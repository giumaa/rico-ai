// Main-process side of the LLM engine: spawns/supervises the utilityProcess (worker.ts), forwards requests,
// and turns worker messages into typed callbacks. No model logic lives here.

import { utilityProcess, type UtilityProcess } from 'electron';
import { constants as osConstants, setPriority } from 'node:os';
import type { ModelLoadState } from '../../shared/api';
import type { Turn } from '../persona';
import { EngineError } from './errors';
import type { FromWorker, LoadedInfo, LoadParams, Sampling, ToWorker, WorkerHardware } from './protocol';
import type { Engine, GenerateHandlers } from './types';

export { EngineError, type EngineErrorCode } from './errors';

interface Pending<T> {
  resolve(v: T): void;
  reject(e: unknown): void;
}

export interface EngineHostOptions {
  /** Absolute path of the bundled worker (out/main/engineWorker.js). */
  workerPath: string;
  log?: (...args: unknown[]) => void;
}

export class EngineHost implements Engine {
  private child: UtilityProcess | undefined;
  private starting: Promise<UtilityProcess> | undefined;
  private nextId = 1;
  private pendingLoad = new Map<number, Pending<LoadedInfo>>();
  private pendingHardware = new Map<number, Pending<WorkerHardware>>();
  private pendingUnload = new Map<number, Pending<void>>();
  private generations = new Map<string, GenerateHandlers>();
  private hardwareCache: WorkerHardware | undefined;
  private cpuOnly = false;
  private stderrTail: string[] = [];
  private shuttingDown = false;

  private state: ModelLoadState = { state: 'idle' };
  private loadedInfo: LoadedInfo | undefined;
  private listeners = new Set<(s: ModelLoadState) => void>();

  constructor(private readonly opts: EngineHostOptions) {}

  private log(...args: unknown[]): void {
    this.opts.log?.(...args);
  }

  // -------------------------------------------------------------------------------------------------------
  // state

  getLoadState(): ModelLoadState {
    return { ...this.state };
  }

  getLoadedInfo(): LoadedInfo | undefined {
    return this.loadedInfo;
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
        this.log('load-state listener failed', err);
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // process management

  private ensureWorker(): Promise<UtilityProcess> {
    if (this.child) return Promise.resolve(this.child);
    if (this.starting) return this.starting;
    this.starting = new Promise<UtilityProcess>((resolve, reject) => {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
      env.NODE_LLAMA_CPP_SKIP_DOWNLOAD = 'true';
      if (this.cpuOnly) env.RICO_FORCE_CPU = '1';

      const child = utilityProcess.fork(this.opts.workerPath, [], {
        serviceName: 'Rico Engine',
        stdio: 'pipe',
        env
      });
      let settled = false;

      child.stdout?.on('data', (d: Buffer) => this.log('[engine]', d.toString().trimEnd()));
      child.stderr?.on('data', (d: Buffer) => {
        const text = d.toString().trimEnd();
        this.log('[engine:err]', text);
        this.stderrTail.push(text);
        if (this.stderrTail.length > 20) this.stderrTail.shift();
      });
      child.on('spawn', () => {
        try {
          if (child.pid) setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
        } catch (err) {
          this.log('could not lower engine priority', err);
        }
      });
      child.on('message', (m: FromWorker) => {
        if (m.type === 'ready' && !settled) {
          settled = true;
          this.child = child;
          this.starting = undefined;
          resolve(child);
          return;
        }
        this.handleMessage(m);
      });
      child.on('exit', (code) => {
        if (!settled) {
          settled = true;
          this.starting = undefined;
          reject(new EngineError(`Engine process exited during startup (code ${code})`, 'crashed'));
        }
        if (this.child === child) this.child = undefined;
        this.handleExit(code);
      });
    });
    return this.starting;
  }

  private post(msg: ToWorker): void {
    this.child?.postMessage(msg);
  }

  private handleExit(code: number): void {
    if (this.shuttingDown) return;
    const tail = this.stderrTail.join('\n');
    this.log(`engine exited with code ${code}`, tail);
    const err = new EngineError(`The AI engine stopped unexpectedly (code ${code})`, 'crashed');
    for (const p of this.pendingLoad.values()) p.reject(err);
    for (const p of this.pendingHardware.values()) p.reject(err);
    for (const p of this.pendingUnload.values()) p.resolve();
    this.pendingLoad.clear();
    this.pendingHardware.clear();
    this.pendingUnload.clear();
    for (const [, h] of this.generations) h.onError({ message: err.message, code: 'crashed' });
    this.generations.clear();
    this.loadedInfo = undefined;
    if (this.state.state === 'ready' || this.state.state === 'loading') {
      this.setState({ modelId: this.state.modelId, state: 'error', error: err.message });
    }
  }

  private handleMessage(m: FromWorker): void {
    switch (m.type) {
      case 'hardware-result': {
        const p = this.pendingHardware.get(m.id);
        this.pendingHardware.delete(m.id);
        p?.resolve(m.info);
        break;
      }
      case 'load-result': {
        const p = this.pendingLoad.get(m.id);
        this.pendingLoad.delete(m.id);
        if (!p) break;
        if (m.ok) p.resolve(m.info);
        else p.reject(new EngineError(m.error, m.code ?? 'other'));
        break;
      }
      case 'unload-result': {
        const p = this.pendingUnload.get(m.id);
        this.pendingUnload.delete(m.id);
        p?.resolve();
        break;
      }
      case 'token':
        this.generations.get(m.requestId)?.onToken(m.chunk);
        break;
      case 'done': {
        const h = this.generations.get(m.requestId);
        this.generations.delete(m.requestId);
        h?.onDone({ text: m.text, tokensPerSecond: m.tokensPerSecond, stopped: m.stopped });
        break;
      }
      case 'error': {
        const h = this.generations.get(m.requestId);
        this.generations.delete(m.requestId);
        h?.onError({ message: m.message, code: m.code });
        break;
      }
      case 'ready':
        break;
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // API

  /** GPU / core facts (cached). Rejects on failure; callers should fall back to defaults. */
  async hardware(timeoutMs = 45_000): Promise<WorkerHardware> {
    if (this.hardwareCache) return this.hardwareCache;
    await this.ensureWorker();
    const id = this.nextId++;
    const info = await new Promise<WorkerHardware>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingHardware.delete(id);
        reject(new EngineError('Hardware detection timed out'));
      }, timeoutMs);
      this.pendingHardware.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        }
      });
      this.post({ type: 'hardware', id });
    });
    this.hardwareCache = info;
    return info;
  }

  /** Loads a model (unloading the previous one). Retries once on the CPU if the GPU backend crashes the worker. */
  async load(modelId: string, params: LoadParams): Promise<LoadedInfo> {
    this.setState({ modelId, state: 'loading' });
    try {
      let info: LoadedInfo;
      try {
        info = await this.loadOnce(params);
      } catch (err) {
        if (err instanceof EngineError && err.code === 'crashed' && !this.cpuOnly) {
          this.log('engine crashed while loading; retrying with GPU disabled');
          this.cpuOnly = true;
          this.hardwareCache = undefined;
          info = await this.loadOnce(params);
        } else {
          throw err;
        }
      }
      this.loadedInfo = info;
      this.setState({ modelId, state: 'ready' });
      return info;
    } catch (err) {
      this.loadedInfo = undefined;
      this.setState({ modelId, state: 'error', error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  private async loadOnce(params: LoadParams): Promise<LoadedInfo> {
    await this.ensureWorker();
    const id = this.nextId++;
    return new Promise<LoadedInfo>((resolve, reject) => {
      this.pendingLoad.set(id, { resolve, reject });
      this.post({ type: 'load', id, params });
    });
  }

  async unload(): Promise<void> {
    this.loadedInfo = undefined;
    if (this.child) {
      const id = this.nextId++;
      await new Promise<void>((resolve) => {
        this.pendingUnload.set(id, { resolve, reject: () => resolve() });
        this.post({ type: 'unload', id });
      });
    }
    this.setState({ state: 'idle' });
  }

  generate(
    requestId: string,
    req: { systemPrompt: string; turns: Turn[]; sampling: Sampling },
    handlers: GenerateHandlers
  ): void {
    if (!this.child) {
      handlers.onError({ message: 'The AI engine is not running', code: 'no-model' });
      return;
    }
    this.generations.set(requestId, handlers);
    this.post({ type: 'generate', requestId, ...req });
  }

  abort(requestId: string): void {
    this.post({ type: 'abort', requestId });
  }

  hasActiveGeneration(): boolean {
    return this.generations.size > 0;
  }

  /** Stops the worker (used on app quit and to free memory). */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    try {
      child.postMessage({ type: 'shutdown' } satisfies ToWorker);
    } catch {
      /* already gone */
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill();
        resolve();
      }, 1500);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}
