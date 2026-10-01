import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Turn } from '../persona';
import { EngineError } from './errors';
import type { LoadParams } from './protocol';
import { ServerEngine } from './serverEngine';
import type { GenerateHandlers } from './types';

const FAKE = join(__dirname, '__fixtures__', 'fake-llama-server.cjs');

function gguf(): Buffer {
  // GGUF v3 header with kv_count = 0: enough for the metadata reader (it finds nothing and moves on)
  const b = Buffer.alloc(24);
  b.write('GGUF', 0, 'latin1');
  b.writeUInt32LE(3, 4);
  return b;
}

describe('ServerEngine (against a fake llama-server)', () => {
  let dir: string;
  let modelPath: string;
  let mmprojPath: string;
  let argsFile: string;
  let recordFile: string;
  let engine: ServerEngine;
  let extraEnv: Record<string, string>;

  const params = (over: Partial<LoadParams> = {}): LoadParams => ({
    modelPath,
    perfMode: 'eco',
    requestedContext: 4096,
    totalRamGB: 16,
    modelSizeGB: 2.5,
    ...over
  });

  const make = (): ServerEngine =>
    new ServerEngine({
      binaries: () => [FAKE],
      hardware: async () => ({ gpuType: 'none', physicalCores: 6, logicalCores: 12 }),
      startTimeoutMs: 15_000,
      lowerPriority: false,
      launch: (exe, args, env) =>
        spawn(process.execPath, [exe, ...args], {
          env: { ...env, ...extraEnv, FAKE_ARGS_FILE: argsFile, FAKE_RECORD_FILE: recordFile },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        })
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rico-se-'));
    modelPath = join(dir, 'model.gguf');
    mmprojPath = join(dir, 'mmproj.gguf');
    argsFile = join(dir, 'args.log');
    recordFile = join(dir, 'requests.log');
    await Promise.all([writeFile(modelPath, gguf()), writeFile(mmprojPath, gguf())]);
    extraEnv = {};
    engine = make();
  });
  afterEach(async () => {
    await engine.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  const run = (turns: Turn[], sampling = { temperature: 0.7, maxTokens: 256 }) =>
    new Promise<{ tokens: string[]; done?: { text: string; tokensPerSecond?: number; stopped: boolean }; error?: { message: string; code?: string } }>((resolve) => {
      const res: { tokens: string[]; done?: { text: string; tokensPerSecond?: number; stopped: boolean }; error?: { message: string; code?: string } } = { tokens: [] };
      const handlers: GenerateHandlers = {
        onToken: (c) => res.tokens.push(c),
        onDone: (d) => resolve({ ...res, done: d }),
        onError: (e) => resolve({ ...res, error: e })
      };
      engine.generate('req-1', { systemPrompt: 'SYS', turns, sampling }, handlers);
    });

  it('starts the sidecar, reports ready and passes the API key through the environment only', async () => {
    const states: string[] = [];
    engine.onLoadState((s) => states.push(s.state));
    expect(engine.isAvailable()).toBe(true);
    const info = await engine.load('m1', params());
    expect(info).toMatchObject({ engine: 'llama-server', vision: false, wrapper: 'llama-server' });
    expect(info.contextSize).toBeGreaterThan(0);
    expect(states).toEqual(['loading', 'ready']);
    expect(engine.getLoadState()).toEqual({ modelId: 'm1', state: 'ready' });

    const logged = JSON.parse((await readFile(argsFile, 'utf8')).trim().split('\n')[0]!) as { args: string[]; hasKey: boolean };
    expect(logged.hasKey).toBe(true);
    expect(logged.args).not.toContain('--api-key');
    expect(logged.args[logged.args.indexOf('--host') + 1]).toBe('127.0.0.1');
    expect(logged.args).not.toContain('--mmproj');
  });

  it('enables vision when a projector is given and the server reports the modality', async () => {
    const info = await engine.load('v', params({ mmprojPath }));
    expect(info.vision).toBe(true);
    const logged = JSON.parse((await readFile(argsFile, 'utf8')).trim().split('\n')[0]!) as { args: string[] };
    expect(logged.args[logged.args.indexOf('--mmproj') + 1]).toBe(mmprojPath);
  });

  it('streams tokens, then done with the full text and the server tokens/sec', async () => {
    await engine.load('m', params());
    const r = await run([{ role: 'user', content: 'hello' }]);
    expect(r.error).toBeUndefined();
    expect(r.done?.stopped).toBe(false);
    expect(r.done?.text).toBe('msgs=2 images=0 echo=hello done');
    expect(r.done?.tokensPerSecond).toBe(42.4);
    expect(r.tokens.join('')).toBe(r.done?.text);
    expect(r.tokens.join('').startsWith(' ')).toBe(false); // leading whitespace trimmed
  });

  it('sends images as image_url parts and includes the system prompt', async () => {
    await engine.load('v', params({ mmprojPath }));
    const r = await run([{ role: 'user', content: 'what is this?', images: [{ id: 'a', mime: 'image/png', dataBase64: 'iVBORw0KGgo=' }] }]);
    expect(r.done?.text).toBe('msgs=2 images=1 echo=what is this? done');
    const sent = JSON.parse((await readFile(recordFile, 'utf8')).trim().split('\n')[0]!) as { messages: Array<{ role: string; content: unknown }>; stream: boolean };
    expect(sent.stream).toBe(true);
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(JSON.stringify(sent.messages[1])).toContain('data:image/png;base64,iVBORw0KGgo=');
  });

  it('strips <think> blocks that arrive split across chunks', async () => {
    extraEnv = { FAKE_MODE: 'think' };
    engine = make();
    await engine.load('m', params());
    const r = await run([{ role: 'user', content: 'x' }]);
    expect(r.done?.text).toBe('Hello world');
    expect(r.tokens.join('')).toBe('Hello world');
  });

  it('can be stopped: done arrives with stopped=true and the partial text, and the engine is reusable', async () => {
    extraEnv = { FAKE_MODE: 'slow' };
    engine = make();
    await engine.load('m', params());
    const handlers: { tokens: string[] } = { tokens: [] };
    const result = await new Promise<{ text: string; stopped: boolean }>((resolve) => {
      engine.generate('req-1', { systemPrompt: 'S', turns: [{ role: 'user', content: 'go' }], sampling: { temperature: 0.7, maxTokens: 100 } }, {
        onToken: (c) => {
          handlers.tokens.push(c);
          if (handlers.tokens.join('').includes('echo=')) engine.abort('req-1');
        },
        onDone: resolve,
        onError: (e) => resolve({ text: `ERR ${e.message}`, stopped: false })
      });
    });
    expect(result.stopped).toBe(true);
    expect(result.text).toContain('echo=go');
    expect(engine.hasActiveGeneration()).toBe(false);
    // the slot is free again: a second request can be started (and stopped) right away
    const again = await new Promise<{ stopped: boolean }>((resolve) => {
      engine.generate('req-2', { systemPrompt: 'S', turns: [{ role: 'user', content: 'again' }], sampling: { temperature: 0.7, maxTokens: 100 } }, {
        onToken: () => engine.abort('req-2'),
        onDone: resolve,
        onError: () => resolve({ stopped: false })
      });
    });
    expect(again.stopped).toBe(true);
  });

  it('retries with a shorter history when the server reports a context overflow', async () => {
    extraEnv = { FAKE_MODE: 'overflow-once' };
    engine = make();
    await engine.load('m', params());
    const turns: Turn[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' }
    ];
    const r = await run(turns);
    expect(r.error).toBeUndefined();
    const sent = (await readFile(recordFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { messages: unknown[] });
    expect(sent).toHaveLength(2);
    expect(sent[0]!.messages.length).toBe(6); // system + 5
    expect(sent[1]!.messages.length).toBe(4); // oldest pair dropped
  });

  it('reports HTTP errors from the server', async () => {
    extraEnv = { FAKE_MODE: 'http-error' };
    engine = make();
    await engine.load('m', params());
    const r = await run([{ role: 'user', content: 'x' }]);
    expect(r.error?.message).toBe('boom');
    expect(r.error?.code).toBe('other');
  });

  it('reports a crash while generating and flips the load state to error', async () => {
    extraEnv = { FAKE_MODE: 'die-mid-stream' };
    engine = make();
    await engine.load('m', params());
    const r = await run([{ role: 'user', content: 'x' }]);
    expect(r.error?.code).toBe('crashed');
    await new Promise((r2) => setTimeout(r2, 50));
    expect(engine.getLoadState().state).toBe('error');
  });

  it('rejects generate() without a loaded model and concurrent requests', async () => {
    const r = await run([{ role: 'user', content: 'x' }]);
    expect(r.error?.code).toBe('no-model');
    extraEnv = { FAKE_MODE: 'slow' };
    engine = make();
    await engine.load('m', params());
    engine.generate('a', { systemPrompt: 'S', turns: [{ role: 'user', content: 'x' }], sampling: { temperature: 0.7, maxTokens: 10 } }, { onToken: () => undefined, onDone: () => undefined, onError: () => undefined });
    const second = await new Promise<{ code?: string }>((resolve) =>
      engine.generate('b', { systemPrompt: 'S', turns: [{ role: 'user', content: 'x' }], sampling: { temperature: 0.7, maxTokens: 10 } }, { onToken: () => undefined, onDone: () => resolve({}), onError: resolve })
    );
    expect(second.code).toBe('busy');
    engine.abort('a');
  });

  it('unload stops the process and goes idle', async () => {
    await engine.load('m', params());
    await engine.unload();
    expect(engine.getLoadState()).toEqual({ state: 'idle' });
    expect(engine.getLoadedInfo()).toBeUndefined();
    const r = await run([{ role: 'user', content: 'x' }]);
    expect(r.error?.code).toBe('no-model');
  });

  describe('startup failures', () => {
    it('gives up immediately on a bad model file', async () => {
      extraEnv = { FAKE_MODE: 'bad-file' };
      engine = make();
      await expect(engine.load('m', params())).rejects.toMatchObject({ code: 'bad-file' });
      expect((await readFile(argsFile, 'utf8')).trim().split('\n')).toHaveLength(1);
      expect(engine.getLoadState().state).toBe('error');
    });

    it('walks down the fallback ladder on out-of-memory (smaller, CPU-only) before failing', async () => {
      extraEnv = { FAKE_MODE: 'oom' };
      engine = make();
      await expect(engine.load('m', params())).rejects.toMatchObject({ code: 'oom' });
      const launches = (await readFile(argsFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { args: string[] });
      // no GPU in this test: first attempt is already CPU-only, then the 2048-token attempt
      expect(launches.length).toBe(2);
      expect(launches[1]!.args[launches[1]!.args.indexOf('-c') + 1]).toBe('2048');
    });

    it('classifies an OS application-control block', async () => {
      extraEnv = { FAKE_MODE: 'blocked' };
      engine = make();
      await expect(engine.load('m', params())).rejects.toMatchObject({ code: 'blocked' });
    });

    it('reports "unavailable" when no binary is installed', async () => {
      const none = new ServerEngine({ binaries: () => [] });
      expect(none.isAvailable()).toBe(false);
      await expect(none.load('m', params())).rejects.toBeInstanceOf(EngineError);
      await expect(none.load('m', params())).rejects.toMatchObject({ code: 'unavailable' });
    });
  });
});
