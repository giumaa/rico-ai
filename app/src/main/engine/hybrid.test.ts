import { describe, expect, it } from 'vitest';
import type { ModelLoadState } from '../../shared/api';
import { EngineError, type EngineErrorCode } from './errors';
import { HybridEngine } from './hybrid';
import type { LoadedInfo, LoadParams } from './protocol';
import type { Backend, GenerateHandlers } from './types';

class FakeBackend implements Backend {
  loads: LoadParams[] = [];
  unloads = 0;
  generated: string[] = [];
  failWith: EngineErrorCode | undefined;
  available = true;
  private listeners = new Set<(s: ModelLoadState) => void>();
  private info: LoadedInfo | undefined;

  constructor(readonly name: 'llama-server' | 'node-llama-cpp') {}

  isAvailable(): boolean {
    return this.available;
  }
  async hardware() {
    return { gpuType: 'none' as const };
  }
  async load(_id: string, params: LoadParams): Promise<LoadedInfo> {
    this.loads.push(params);
    if (this.failWith) throw new EngineError(`fail ${this.failWith}`, this.failWith);
    this.info = { contextSize: 4096, threads: 4, gpuLayers: 0, gpu: 'none', engine: this.name, vision: this.name === 'llama-server' && !!params.mmprojPath };
    return this.info;
  }
  async unload(): Promise<void> {
    this.unloads++;
    this.info = undefined;
  }
  generate(requestId: string, _req: unknown, handlers: GenerateHandlers): void {
    this.generated.push(requestId);
    handlers.onDone({ text: this.name, stopped: false });
  }
  abort(): void {}
  hasActiveGeneration(): boolean {
    return false;
  }
  getLoadState(): ModelLoadState {
    return { state: 'idle' };
  }
  getLoadedInfo(): LoadedInfo | undefined {
    return this.info;
  }
  onLoadState(cb: (s: ModelLoadState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(s: ModelLoadState): void {
    for (const l of this.listeners) l(s);
  }
  async shutdown(): Promise<void> {}
}

const params = (over: Partial<LoadParams> = {}): LoadParams => ({
  modelPath: 'm.gguf',
  perfMode: 'eco',
  requestedContext: 4096,
  totalRamGB: 16,
  modelSizeGB: 2.5,
  ...over
});

function setup() {
  const worker = new FakeBackend('node-llama-cpp');
  const sidecar = new FakeBackend('llama-server');
  const states: string[] = [];
  const engine = new HybridEngine(worker, sidecar);
  engine.onLoadState((s) => states.push(s.state));
  return { worker, sidecar, engine, states };
}

describe('HybridEngine', () => {
  it('uses the sidecar for text and vision models when it is available', async () => {
    const { engine, worker, sidecar, states } = setup();
    const info = await engine.load('m', params({ mmprojPath: 'mm.gguf' }));
    expect(info).toMatchObject({ engine: 'llama-server', vision: true });
    expect(sidecar.loads).toHaveLength(1);
    expect(worker.loads).toHaveLength(0);
    expect(states).toEqual(['loading', 'ready']);
    expect(engine.getLoadedInfo()).toBe(info);

    const done: string[] = [];
    engine.generate('r1', { systemPrompt: '', turns: [], sampling: { temperature: 0.7, maxTokens: 10 } }, { onToken: () => undefined, onDone: (e) => done.push(e.text), onError: () => undefined });
    expect(done).toEqual(['llama-server']);
  });

  it('falls back to text-only node-llama-cpp when the sidecar is blocked by the OS, and says why', async () => {
    const { engine, worker, sidecar } = setup();
    sidecar.failWith = 'blocked';
    const info = await engine.load('m', params({ mmprojPath: 'mm.gguf' }));
    expect(info).toMatchObject({ engine: 'node-llama-cpp', vision: false });
    expect(info.visionNote).toContain('blocked');
    expect(worker.loads[0]!.mmprojPath).toBeUndefined(); // the worker can never get the projector
  });

  it('falls back on crashes and when the sidecar binary is missing', async () => {
    const a = setup();
    a.sidecar.failWith = 'crashed';
    expect((await a.engine.load('m', params())).engine).toBe('node-llama-cpp');

    const b = setup();
    b.sidecar.available = false;
    const info = await b.engine.load('m', params({ mmprojPath: 'mm.gguf' }));
    expect(info).toMatchObject({ engine: 'node-llama-cpp', vision: false });
    expect(info.visionNote).toMatch(/not installed/);
    expect(b.sidecar.loads).toHaveLength(0);
  });

  it('does not hide real model problems behind the fallback', async () => {
    const { engine, worker, sidecar, states } = setup();
    sidecar.failWith = 'bad-file';
    await expect(engine.load('m', params())).rejects.toMatchObject({ code: 'bad-file' });
    sidecar.failWith = 'oom';
    await expect(engine.load('m', params())).rejects.toMatchObject({ code: 'oom' });
    expect(worker.loads).toHaveLength(0);
    expect(states.filter((s) => s === 'error')).toHaveLength(2);
    expect(engine.getLoadState().state).toBe('error');
  });

  it('works without any sidecar (text only)', async () => {
    const worker = new FakeBackend('node-llama-cpp');
    const engine = new HybridEngine(worker, undefined);
    expect((await engine.load('m', params())).engine).toBe('node-llama-cpp');
  });

  it('unloads both backends before loading and on unload()', async () => {
    const { engine, worker, sidecar, states } = setup();
    await engine.load('a', params());
    await engine.load('b', params());
    expect(worker.unloads).toBe(2);
    expect(sidecar.unloads).toBe(2);
    await engine.unload();
    expect(engine.getLoadState()).toEqual({ state: 'idle' });
    expect(engine.getLoadedInfo()).toBeUndefined();
    expect(states[states.length - 1]).toBe('idle');
    // generating without a model
    const errors: string[] = [];
    engine.generate('r', { systemPrompt: '', turns: [], sampling: { temperature: 0, maxTokens: 1 } }, { onToken: () => undefined, onDone: () => undefined, onError: (e) => errors.push(e.code ?? '') });
    expect(errors).toEqual(['no-model']);
  });

  it('surfaces a crash of the ACTIVE backend as an error state, ignores the inactive one', async () => {
    const { engine, worker, sidecar, states } = setup();
    await engine.load('m', params());
    worker.emit({ state: 'error', error: 'ignored' });
    expect(engine.getLoadState().state).toBe('ready');
    sidecar.emit({ modelId: 'm', state: 'error', error: 'died' });
    expect(engine.getLoadState()).toMatchObject({ state: 'error', error: 'died' });
    expect(engine.getLoadedInfo()).toBeUndefined();
    expect(states[states.length - 1]).toBe('error');
  });
});
