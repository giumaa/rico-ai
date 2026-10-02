// llama-server sidecar backend (vision + text). Launched by main as a child process:
//   - bound to 127.0.0.1 on a random free port, random API key (passed via env, not argv)
//   - below-normal OS priority, threads per performance mode, --offline
//   - talked to ONLY from this process with Node's http module (the renderer can never reach it:
//     Chromium is blocked from the network entirely, see security.ts)
// No Electron imports: unit-tested against a fake llama-server.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { constants as osConstants, setPriority } from 'node:os';
import type { ModelLoadState } from '../../shared/api';
import { readGgufBasics } from '../gguf';
import { StreamEmitter } from '../streamEmitter';
import { imageMaxTokensForContext, perfProfile, pickContextSize, pickVisionContextSize, SMALL_VRAM_GB } from '../tuning';
import { EngineError } from './errors';
import type { LoadedInfo, LoadParams, WorkerHardware } from './protocol';
import {
  buildChatPayload,
  buildServerArgs,
  classifyServerExit,
  conversationBudget,
  dropOldestPair,
  errorMessageFromBody,
  isContextOverflow,
  isPortCollision,
  readChunk,
  serverEnv,
  SseParser,
  trimTurnsToFit
} from './serverCore';
import type { Backend, GenerateHandlers, GenerateInput } from './types';

export interface ServerEngineOptions {
  /** Absolute paths of llama-server executables to try, best first. Evaluated on every load. */
  binaries(preferCpu: boolean): string[];
  /** GPU / core facts for the performance profile (optional). */
  hardware?(): Promise<WorkerHardware | null>;
  /** Where to record the sidecar PID so a crashed app can clean it up next start. */
  pidFile?: string;
  log?: (...args: unknown[]) => void;
  /** Max time to wait for the model to load (default 15 minutes: slow disks + huge models). */
  startTimeoutMs?: number;
  /** Test hook: how to start the process. */
  launch?: (exe: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
  /** Test hook: skip lowering the OS priority. */
  lowerPriority?: boolean;
}

interface Attempt {
  gpuLayers: 'auto' | number;
  contextSize: number;
  preferCpu: boolean;
}

interface ActiveGeneration {
  requestId: string;
  req?: http.ClientRequest;
  aborted: boolean;
  /** the sidecar process died while this request was running */
  crashed?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function requestText(port: number, key: string, method: string, path: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: { Authorization: `Bearer ${key}` }, timeout: timeoutMs },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString('utf8') }));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

export class ServerEngine implements Backend {
  private child: ChildProcess | undefined;
  /** The process being started (not ready yet): stop()/shutdown() must be able to kill it. */
  private starting: ChildProcess | undefined;
  private port = 0;
  private key = '';
  private stderrTail: string[] = [];
  private expectedExit = new WeakSet<ChildProcess>();
  private active: ActiveGeneration | undefined;
  /** Resolves (after the exit bookkeeping ran) when the current sidecar process has exited. */
  private childExit: Promise<void> | undefined;
  private cpuOnly = false;

  private state: ModelLoadState = { state: 'idle' };
  private loadedInfo: LoadedInfo | undefined;
  private listeners = new Set<(s: ModelLoadState) => void>();

  constructor(private readonly opts: ServerEngineOptions) {}

  private log(...args: unknown[]): void {
    this.opts.log?.(...args);
  }

  /** True when at least one llama-server executable is installed. */
  isAvailable(): boolean {
    return this.opts.binaries(false).length > 0;
  }

  // ---- state ---------------------------------------------------------------------------------------------

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

  hasActiveGeneration(): boolean {
    return this.active !== undefined;
  }

  // ---- loading -------------------------------------------------------------------------------------------

  async load(modelId: string, params: LoadParams): Promise<LoadedInfo> {
    this.setState({ modelId, state: 'loading' });
    try {
      await this.stop();
      const info = await this.loadWithFallbacks(params);
      this.loadedInfo = info;
      this.setState({ modelId, state: 'ready' });
      return info;
    } catch (err) {
      this.loadedInfo = undefined;
      if (err instanceof EngineError && err.code === 'cancelled') throw err; // superseded by unload()/another load()
      await this.stop().catch(() => undefined);
      this.setState({ modelId, state: 'error', error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  private async loadWithFallbacks(params: LoadParams): Promise<LoadedInfo> {
    const basics = await readGgufBasics(params.modelPath);
    const hw = (await this.opts.hardware?.().catch(() => null)) ?? null;
    const profile = perfProfile(params.perfMode, {
      physicalCores: hw?.physicalCores ?? Math.max(1, Math.floor((hw?.logicalCores ?? 4) / 2)),
      logicalCores: hw?.logicalCores,
      gpuType: this.cpuOnly ? 'none' : (hw?.gpuType ?? 'none'),
      vramGB: hw?.vramGB,
      gpuUnified: hw?.unified,
      modelSizeGB: params.modelSizeGB,
      blockCount: basics.blockCount ?? params.blockCount
    });
    const ctxInput = {
      requested: params.requestedContext,
      totalRamGB: params.totalRamGB,
      modelSizeGB: params.modelSizeGB,
      trainContext: basics.contextLength
    };
    // Images cost ~1000 tokens each: a vision model needs some head-room even on small machines.
    const contextSize = params.mmprojPath ? pickVisionContextSize(ctxInput) : pickContextSize(ctxInput);

    const firstGpu: 'auto' | number = profile.gpuLayersMax !== undefined && profile.gpuLayers === 'auto' ? profile.gpuLayersMax : profile.gpuLayers;
    const attempts: Attempt[] = [{ gpuLayers: firstGpu, contextSize, preferCpu: this.cpuOnly || profile.gpuLayers === 0 }];
    if (firstGpu !== 0) attempts.push({ gpuLayers: 0, contextSize, preferCpu: true });
    attempts.push({ gpuLayers: 0, contextSize: Math.min(contextSize, 2048), preferCpu: true });

    const mmprojOffload = !(profile.gpuLayers === 0 || (params.perfMode === 'eco' && !hw?.unified && (hw?.vramGB ?? 99) <= SMALL_VRAM_GB));
    let lastErr: unknown;
    for (const att of attempts) {
      const bins = this.opts.binaries(att.preferCpu);
      if (bins.length === 0) throw new EngineError('llama-server is not installed in this build', 'unavailable');
      for (const exe of bins) {
        try {
          return await this.startWithPortRetry(exe, params, profile.threads, profile.batchSize, att, mmprojOffload, hw, basics.contextLength);
        } catch (err) {
          lastErr = err;
          if (!(err instanceof EngineError)) throw err;
          if (err.code === 'cancelled') throw err;
          this.log(`llama-server attempt failed (${err.code}): ${err.message}`);
          if (err.code === 'bad-file') throw err; // no retry can fix a bad model file
          if (err.code === 'oom') break; // next, smaller attempt
          if (err.code === 'crashed' && att.gpuLayers !== 0) this.cpuOnly = this.cpuOnly || exe.includes('vulkan');
        }
      }
      // The OS refuses to run the binaries at all: smaller / CPU-only attempts cannot help.
      if (lastErr instanceof EngineError && lastErr.code === 'blocked') throw lastErr;
    }
    throw lastErr instanceof Error ? lastErr : new EngineError('Could not start llama-server', 'crashed');
  }

  /** A port taken between freePort() and the server's bind is not a crash: same binary, fresh port, no CPU-only downgrade. */
  private async startWithPortRetry(
    exe: string,
    params: LoadParams,
    threads: number,
    batchSize: number,
    att: Attempt,
    mmprojOffload: boolean,
    hw: WorkerHardware | null,
    trainContext: number | undefined
  ): Promise<LoadedInfo> {
    for (let portTry = 0; ; portTry++) {
      try {
        return await this.startOnce(exe, params, threads, batchSize, att, mmprojOffload, hw, trainContext);
      } catch (err) {
        if (portTry < 3 && err instanceof EngineError && err.code === 'crashed' && isPortCollision(this.stderrTail.join('\n'))) {
          this.log(`llama-server could not bind its port (try ${portTry + 1}), retrying on another port`);
          continue;
        }
        throw err;
      }
    }
  }

  private async startOnce(
    exe: string,
    params: LoadParams,
    threads: number,
    batchSize: number,
    att: Attempt,
    mmprojOffload: boolean,
    hw: WorkerHardware | null,
    trainContext: number | undefined
  ): Promise<LoadedInfo> {
    const port = await freePort();
    const key = randomBytes(24).toString('hex');
    const args = buildServerArgs({
      modelPath: params.modelPath,
      mmprojPath: params.mmprojPath,
      port,
      contextSize: att.contextSize,
      threads,
      batchSize,
      gpuLayers: att.gpuLayers,
      mmprojOffload: mmprojOffload && att.gpuLayers !== 0,
      imageMaxTokens: imageMaxTokensForContext(att.contextSize),
      cacheRamMiB: params.totalRamGB >= 24 ? 1024 : 0
    });
    const env = serverEnv(process.env, key, dirname(exe), process.platform);

    this.stderrTail = [];
    let child: ChildProcess;
    try {
      child = this.opts.launch
        ? this.opts.launch(exe, args, env)
        : spawn(exe, args, { cwd: dirname(exe), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      throw new EngineError(`Could not start llama-server: ${(err as Error).message}`, 'blocked');
    }
    this.starting = child;
    const collect = (d: Buffer): void => {
      const text = d.toString('utf8').trimEnd();
      if (!text) return;
      this.log('[llama-server]', text.slice(0, 400));
      this.stderrTail.push(text);
      if (this.stderrTail.length > 30) this.stderrTail.shift();
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('spawn', () => {
      if (this.opts.lowerPriority === false || !child.pid) return;
      try {
        setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
      } catch (err) {
        this.log('could not lower llama-server priority', err);
      }
      if (this.opts.pidFile) void fs.writeFile(this.opts.pidFile, String(child.pid)).catch(() => undefined);
    });

    let exited = false;
    let exitCode: number | null = null;
    child.once('exit', (code) => {
      exited = true;
      exitCode = code;
      if (this.opts.pidFile) void fs.rm(this.opts.pidFile, { force: true }).catch(() => undefined);
      // Only a sidecar that had become ready counts as "crashed"; startup failures are reported by the load loop.
      const wasReady = this.child === child;
      if (wasReady) this.child = undefined;
      if (wasReady && !this.expectedExit.has(child)) this.handleUnexpectedExit(code);
    });
    this.childExit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    let spawnError: Error | undefined;
    child.once('error', (e) => {
      spawnError = e;
    });

    const deadline = Date.now() + (this.opts.startTimeoutMs ?? 15 * 60_000);
    for (;;) {
      if (this.starting !== child) {
        // stop()/unload()/shutdown() or another load() took over while we were waiting
        this.expectedExit.add(child);
        child.kill();
        throw new EngineError('Model start was cancelled', 'cancelled');
      }
      if (spawnError) {
        this.starting = undefined;
        this.expectedExit.add(child);
        const code = (spawnError as NodeJS.ErrnoException).code;
        throw new EngineError(`Could not start llama-server: ${spawnError.message}`, code === 'ENOENT' ? 'unavailable' : 'blocked');
      }
      if (exited) {
        this.starting = undefined;
        this.expectedExit.add(child);
        const tail = this.stderrTail.join('\n');
        throw new EngineError(
          `llama-server exited during startup (code ${exitCode})${tail ? `: ${tail.slice(-300)}` : ''}`,
          classifyServerExit(exitCode, tail)
        );
      }
      if (Date.now() > deadline) {
        this.starting = undefined;
        this.expectedExit.add(child);
        child.kill();
        throw new EngineError('Timed out while loading the model', 'crashed');
      }
      try {
        const r = await requestText(port, key, 'GET', '/health', 2000);
        if (r.status === 200) break;
      } catch {
        /* not listening yet */
      }
      await sleep(200);
    }

    if (this.starting !== child) {
      this.expectedExit.add(child);
      child.kill();
      throw new EngineError('Model start was cancelled', 'cancelled');
    }
    this.starting = undefined;
    this.child = child;
    this.port = port;
    this.key = key;

    let contextSize = att.contextSize;
    let vision = false;
    try {
      const props = await requestText(port, key, 'GET', '/props', 5000);
      const j = JSON.parse(props.body) as {
        default_generation_settings?: { n_ctx?: number };
        modalities?: { vision?: boolean };
      };
      if (typeof j.default_generation_settings?.n_ctx === 'number' && j.default_generation_settings.n_ctx > 0) {
        contextSize = j.default_generation_settings.n_ctx;
      }
      vision = j.modalities?.vision === true;
    } catch (err) {
      this.log('could not read /props', err);
    }
    const info: LoadedInfo = {
      contextSize,
      threads,
      gpuLayers: att.gpuLayers,
      gpu: att.gpuLayers === 0 ? 'none' : (hw?.gpuType ?? 'none'),
      trainContext,
      wrapper: 'llama-server',
      vision,
      engine: 'llama-server'
    };
    if (params.mmprojPath && !vision) info.visionNote = 'projector';
    return info;
  }

  private handleUnexpectedExit(code: number | null): void {
    const tail = this.stderrTail.join('\n');
    const kind = classifyServerExit(code, tail);
    const message = `The AI engine stopped unexpectedly (code ${code})`;
    this.log(message, kind, tail.slice(-300));
    // The in-flight request (if any) reports the failure itself when its socket dies.
    if (this.active) {
      this.active.crashed = true;
      this.active.req?.destroy();
    }
    this.loadedInfo = undefined;
    if (this.state.state === 'ready' || this.state.state === 'loading') {
      this.setState({ modelId: this.state.modelId, state: 'error', error: message });
    }
  }

  async unload(): Promise<void> {
    await this.stop();
    this.loadedInfo = undefined;
    this.setState({ state: 'idle' });
  }

  private async stop(): Promise<void> {
    const procs = [this.child, this.starting];
    this.child = undefined;
    this.starting = undefined; // makes a pending startup poll give up and kill its process
    if (this.active) {
      this.active.aborted = true;
      this.active.req?.destroy();
    }
    await Promise.all(procs.map((c) => this.kill(c)));
  }

  private async kill(child: ChildProcess | undefined): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    this.expectedExit.add(child);
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      child.kill();
    });
  }

  async shutdown(): Promise<void> {
    await this.stop();
  }

  // ---- generation ----------------------------------------------------------------------------------------

  generate(requestId: string, input: GenerateInput, handlers: GenerateHandlers): void {
    if (!this.child || !this.loadedInfo) {
      handlers.onError({ message: 'No model is loaded', code: 'no-model' });
      return;
    }
    if (this.active) {
      handlers.onError({ message: 'The engine is busy with another request', code: 'busy' });
      return;
    }
    this.active = { requestId, aborted: false };
    // Release the slot BEFORE telling the caller: a follow-up generate() must never see "busy".
    const release = (): void => {
      if (this.active?.requestId === requestId) this.active = undefined;
    };
    const wrapped: GenerateHandlers = {
      onToken: (c) => handlers.onToken(c),
      onDone: (e) => {
        release();
        handlers.onDone(e);
      },
      onError: (e) => {
        release();
        handlers.onError(e);
      }
    };
    void this.run(requestId, input, wrapped).finally(release);
  }

  abort(requestId: string): void {
    const a = this.active;
    if (a && a.requestId === requestId) {
      a.aborted = true;
      a.req?.destroy();
    }
  }

  private async run(requestId: string, input: GenerateInput, handlers: GenerateHandlers): Promise<void> {
    const ctx = this.loadedInfo?.contextSize ?? 4096;
    const turns = trimTurnsToFit(input.turns, conversationBudget(ctx, input.sampling.maxTokens, input.systemPrompt));
    const emitter = new StreamEmitter((chunk) => handlers.onToken(chunk));
    for (let attempt = 0; attempt < 8; attempt++) {
      const payload = buildChatPayload({ systemPrompt: input.systemPrompt, turns, sampling: input.sampling });
      const outcome = await this.stream(requestId, payload, emitter, handlers);
      if (outcome !== 'overflow') return;
      if (!dropOldestPair(turns)) {
        handlers.onError({ message: 'The message is too long for the model context window', code: 'context' });
        return;
      }
    }
    handlers.onError({ message: 'The conversation does not fit the model context window', code: 'context' });
  }

  private stream(
    requestId: string,
    payload: Record<string, unknown>,
    emitter: StreamEmitter,
    handlers: GenerateHandlers
  ): Promise<'done' | 'error' | 'overflow'> {
    return new Promise((resolve) => {
      const active = this.active;
      if (!active || active.requestId !== requestId) return resolve('error');
      const body = JSON.stringify(payload);
      const parser = new SseParser();
      let settled = false;
      let deltas = 0;
      let firstAt = 0;
      let lastAt = 0;
      let serverTps: number | undefined;

      const finish = (outcome: 'done' | 'error' | 'overflow', run?: () => void): void => {
        if (settled) return;
        settled = true;
        run?.();
        resolve(outcome);
      };
      const finishText = (): void => {
        const text = emitter.finish();
        const elapsed = (lastAt - firstAt) / 1000;
        const computed = deltas > 2 && elapsed > 0.2 ? Math.round(((deltas - 1) / elapsed) * 10) / 10 : undefined;
        handlers.onDone({ text, tokensPerSecond: serverTps ?? computed, stopped: active.aborted });
      };

      const fail = (message: string): void => {
        void (async () => {
          // A dead socket usually means the process died: give the exit event a moment to arrive so we report "crashed".
          if (!active.crashed && this.childExit) await Promise.race([this.childExit, sleep(300)]);
          finish('error', () => {
            emitter.finish();
            if (active.crashed) handlers.onError({ message: 'The AI engine stopped unexpectedly', code: 'crashed' });
            else handlers.onError({ message, code: 'other' });
          });
        })();
      };

      const handleEvents = (events: ReturnType<SseParser['push']>): void => {
        for (const ev of events) {
          if (ev.kind === 'done') continue;
          const c = readChunk(ev.data);
          if (c.error) {
            fail(c.error.message);
            return;
          }
          if (c.content) {
            const now = Date.now();
            if (!firstAt) firstAt = now;
            lastAt = now;
            deltas++;
            emitter.push(c.content);
          }
          if (c.tokensPerSecond !== undefined) serverTps = c.tokensPerSecond;
        }
      };

      const req = http.request(
        {
          host: '127.0.0.1',
          port: this.port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.key}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          }
        },
        (res) => {
          res.setEncoding('utf8');
          if (res.statusCode !== 200) {
            let text = '';
            res.on('data', (c: string) => (text += c));
            res.on('end', () => {
              if (isContextOverflow(res.statusCode ?? 0, text)) return finish('overflow');
              fail(errorMessageFromBody(text));
            });
            return;
          }
          res.on('data', (c: string) => handleEvents(parser.push(c)));
          res.on('end', () => {
            handleEvents(parser.flush());
            finish('done', finishText);
          });
          res.on('error', (err) => {
            if (active.aborted) finish('done', finishText);
            else fail(err.message);
          });
          res.on('close', () => {
            if (!settled) {
              if (active.aborted) finish('done', finishText);
              else fail('The connection to the AI engine was lost');
            }
          });
        }
      );
      active.req = req;
      req.on('error', (err) => {
        if (active.aborted) finish('done', finishText);
        else fail(err.message);
      });
      req.end(body);
    });
  }
}
