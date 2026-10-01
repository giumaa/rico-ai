// LLM engine — runs inside an Electron utilityProcess (NOT the UI/main process), at below-normal OS priority,
// so a busy model can never freeze the user's PC or the UI.
// Talks to the main process through process.parentPort using the protocol in ./protocol.ts.

import os from 'node:os';
import type {
  ChatHistoryItem,
  Llama,
  LlamaChatSession,
  LlamaContext,
  LlamaModel
} from 'node-llama-cpp';
import type { FromWorker, LoadedInfo, LoadParams, Sampling, ToWorker, WorkerHardware } from './protocol';
import { perfProfile, pickContextSize, pickGpuName } from '../tuning';
import { StreamEmitter } from '../streamEmitter';
import type { Turn } from '../persona';

interface ParentPortLike {
  on(event: 'message', listener: (e: { data: ToWorker }) => void): void;
  postMessage(message: FromWorker): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
if (!parentPort) {
  // Started outside Electron (e.g. by mistake): nothing to do.
  console.error('[engine] process.parentPort is missing; this file must run inside an Electron utilityProcess');
  process.exit(1);
}
const port: ParentPortLike = parentPort;

const GiB = 1024 ** 3;

function post(msg: FromWorker): void {
  port.postMessage(msg);
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

// Lower our own priority first thing (the host also does it from the outside).
try {
  os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
} catch {
  /* not fatal */
}

// ---------------------------------------------------------------------------------------------------------
// node-llama-cpp is ESM-only; this worker is bundled as CJS, so it is loaded with a dynamic import().

type NodeLlamaCpp = typeof import('node-llama-cpp');
let libPromise: Promise<NodeLlamaCpp> | undefined;
function lib(): Promise<NodeLlamaCpp> {
  return (libPromise ??= import('node-llama-cpp'));
}

let llama: Llama | undefined;
let hardwareCache: WorkerHardware | undefined;
let model: LlamaModel | undefined;
let context: LlamaContext | undefined;
let session: LlamaChatSession | undefined;
let loaded: LoadedInfo | undefined;

let busy = false;
const aborts = new Map<string, AbortController>();

async function getLlamaInstance(): Promise<Llama> {
  if (llama) return llama;
  const nl = await lib();
  const cpuOnly = process.env.RICO_FORCE_CPU === '1';
  llama = await nl.getLlama({
    gpu: cpuOnly ? false : 'auto',
    // Never compile or download anything at runtime: the app must work fully offline with prebuilt binaries only.
    build: 'never',
    skipDownload: true,
    progressLogs: false,
    logLevel: nl.LlamaLogLevel.warn,
    // We choose the thread count per performance mode ourselves.
    maxThreads: 0
  });
  return llama;
}

async function detectHardware(): Promise<WorkerHardware> {
  if (hardwareCache) return hardwareCache;
  const l = await getLlamaInstance();
  const info: WorkerHardware = {
    gpuType: l.gpu === false ? 'none' : l.gpu,
    physicalCores: l.cpuMathCores > 0 ? l.cpuMathCores : undefined,
    logicalCores: typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
  };
  if (l.gpu !== false) {
    try {
      const names = await l.getGpuDeviceNames();
      const vram = await l.getVramState();
      // "total" also counts memory shared with the CPU (integrated GPUs): dedicated VRAM is what is left over.
      const dedicated = Math.max(0, vram.total - vram.unifiedSize);
      const integratedOnly = l.gpu === 'metal' || dedicated < 0.5 * GiB;
      info.unified = integratedOnly;
      const gb = (integratedOnly ? vram.total : dedicated) / GiB;
      if (gb > 0) info.vramGB = Math.round(gb * 10) / 10;
      const name = pickGpuName(names, integratedOnly);
      if (name) info.gpuName = name;
    } catch {
      /* GPU details are optional */
    }
  }
  hardwareCache = info;
  return info;
}

async function unloadModel(): Promise<void> {
  const s = session;
  const c = context;
  const m = model;
  session = undefined;
  context = undefined;
  model = undefined;
  loaded = undefined;
  try {
    s?.dispose({ disposeSequence: false });
  } catch {
    /* ignore */
  }
  try {
    await c?.dispose();
  } catch {
    /* ignore */
  }
  try {
    await m?.dispose();
  } catch {
    /* ignore */
  }
}

function isOutOfMemory(err: unknown, nl: NodeLlamaCpp): boolean {
  return err instanceof nl.InsufficientMemoryError || /out of memory|insufficient memory|not enough memory/i.test(errMessage(err));
}

async function loadModel(params: LoadParams): Promise<LoadedInfo> {
  await unloadModel();
  const nl = await lib();
  const l = await getLlamaInstance();
  const hw = await detectHardware();

  let blockCount: number | undefined;
  let trainContext: number | undefined;
  try {
    const gguf = await nl.readGgufFileInfo(params.modelPath, {
      readTensorInfo: false,
      sourceType: 'filesystem', // never touch the network
      logWarnings: false
    });
    const meta = gguf.architectureMetadata as { block_count?: number; context_length?: number };
    blockCount = meta.block_count;
    trainContext = meta.context_length;
  } catch (err) {
    throw Object.assign(new Error(`Not a valid GGUF model file: ${errMessage(err)}`), { rico: 'bad-file' });
  }

  const profile = perfProfile(params.perfMode, {
    physicalCores: hw.physicalCores ?? Math.max(1, Math.floor((hw.logicalCores ?? 4) / 2)),
    logicalCores: hw.logicalCores,
    gpuType: hw.gpuType,
    vramGB: hw.vramGB,
    gpuUnified: hw.unified,
    modelSizeGB: params.modelSizeGB,
    blockCount
  });
  const contextSize = pickContextSize({
    requested: params.requestedContext,
    totalRamGB: params.totalRamGB,
    modelSizeGB: params.modelSizeGB,
    trainContext
  });

  const tryLoad = async (gpuLayers: 'auto' | number): Promise<LlamaModel> =>
    l.loadModel({
      modelPath: params.modelPath,
      gpuLayers:
        gpuLayers === 'auto'
          ? {
              min: 0,
              ...(profile.gpuLayersMax !== undefined ? { max: profile.gpuLayersMax } : {}),
              fitContext: { contextSize }
            }
          : gpuLayers,
      useMmap: 'auto'
    });

  let usedGpuLayers: number | 'auto' = profile.gpuLayers;
  try {
    model = await tryLoad(profile.gpuLayers);
  } catch (err) {
    if (profile.gpuLayers === 0) throw err;
    // Retry on the CPU only (GPU drivers can be flaky / VRAM can be taken by other apps).
    usedGpuLayers = 0;
    try {
      model = await tryLoad(0);
    } catch (err2) {
      throw isOutOfMemory(err2, nl) ? Object.assign(err2 as Error, { rico: 'oom' }) : err2;
    }
  }

  const createCtx = (size: { min: number; max: number }): Promise<LlamaContext> =>
    model!.createContext({
      contextSize: size,
      batchSize: profile.batchSize,
      threads: profile.threads
    });
  try {
    context = await createCtx({ min: Math.min(1024, contextSize), max: contextSize });
  } catch (err) {
    if (!isOutOfMemory(err, nl)) throw err;
    try {
      context = await createCtx({ min: 512, max: 2048 });
    } catch (err2) {
      await unloadModel();
      throw Object.assign(err2 as Error, { rico: 'oom' });
    }
  }

  let wrapper = nl.resolveChatWrapper(model!, {
    // Qwen3 "hybrid" templates: never open a thinking block.
    customWrapperSettings: { qwen: { thoughts: 'discourage' } },
    warningLogs: false
  });
  const hint = params.chatTemplateHint?.trim();
  if (wrapper instanceof nl.GeneralChatWrapper && hint) {
    // Auto-detection found nothing specific: trust the catalog's hint if it names a known wrapper.
    const known = (nl.specializedChatWrapperTypeNames as readonly string[]).includes(hint);
    if (known) {
      wrapper = nl.resolveChatWrapper(model!, {
        type: hint as (typeof nl.specializedChatWrapperTypeNames)[number],
        warningLogs: false
      });
    }
  }

  const sequence = context.getSequence();
  session = new nl.LlamaChatSession({
    contextSequence: sequence,
    chatWrapper: wrapper,
    // Keep the persona even for templates without a native system role (the wrapper folds it into the first turn).
    forceAddSystemPrompt: true
  });

  loaded = {
    contextSize: context.contextSize,
    threads: profile.threads,
    gpuLayers: usedGpuLayers === 'auto' ? model!.gpuLayers : usedGpuLayers,
    gpu: hw.gpuType,
    trainContext,
    wrapper: wrapper.wrapperName
  };
  return loaded;
}

// ---------------------------------------------------------------------------------------------------------
// Generation

function toHistory(systemPrompt: string, turns: Turn[]): { history: ChatHistoryItem[]; prompt: string } {
  const history: ChatHistoryItem[] = [{ type: 'system', text: systemPrompt }];
  const last = turns[turns.length - 1];
  const prior = last && last.role === 'user' ? turns.slice(0, -1) : turns;
  for (const t of prior) {
    if (t.role === 'user') history.push({ type: 'user', text: t.content });
    else history.push({ type: 'model', response: [t.content] });
  }
  return { history, prompt: last && last.role === 'user' ? last.content : '' };
}

async function generate(msg: { requestId: string; systemPrompt: string; turns: Turn[]; sampling: Sampling }): Promise<void> {
  const { requestId } = msg;
  if (!session || !model) {
    post({ type: 'error', requestId, message: 'No model is loaded', code: 'no-model' });
    return;
  }
  if (busy) {
    post({ type: 'error', requestId, message: 'The engine is busy with another request', code: 'busy' });
    return;
  }
  const { history, prompt } = toHistory(msg.systemPrompt, msg.turns);
  if (!prompt) {
    post({ type: 'error', requestId, message: 'Empty prompt', code: 'other' });
    return;
  }

  busy = true;
  const ac = new AbortController();
  aborts.set(requestId, ac);

  const emitter = new StreamEmitter((chunk) => post({ type: 'token', requestId, chunk }));
  let tokenCount = 0;
  let firstTokenAt = 0;
  let lastTokenAt = 0;

  try {
    session.setChatHistory(history);
    await session.prompt(prompt, {
      signal: ac.signal,
      stopOnAbortSignal: true,
      maxTokens: msg.sampling.maxTokens,
      temperature: msg.sampling.temperature,
      topP: 0.95,
      topK: 40,
      minP: 0.02,
      repeatPenalty: { penalty: 1.05, lastTokens: 64, penalizeNewLine: false },
      budgets: { thoughtTokens: 0 },
      onToken: (tokens) => {
        const now = Date.now();
        if (!firstTokenAt) firstTokenAt = now;
        lastTokenAt = now;
        tokenCount += tokens.length;
      },
      onTextChunk: (text) => emitter.push(text)
    });
    const full = emitter.finish();
    const elapsed = (lastTokenAt - firstTokenAt) / 1000;
    post({
      type: 'done',
      requestId,
      text: full,
      tokensPerSecond: tokenCount > 2 && elapsed > 0.2 ? Math.round(((tokenCount - 1) / elapsed) * 10) / 10 : undefined,
      stopped: ac.signal.aborted
    });
  } catch (err) {
    const partial = emitter.finish();
    if (ac.signal.aborted) {
      post({ type: 'done', requestId, text: partial, stopped: true });
    } else {
      post({ type: 'error', requestId, message: errMessage(err), code: 'other' });
    }
  } finally {
    aborts.delete(requestId);
    busy = false;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Message loop

async function shutdown(): Promise<void> {
  for (const ac of aborts.values()) ac.abort();
  await unloadModel();
  try {
    await llama?.dispose();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

port.on('message', (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'hardware':
      detectHardware().then(
        (info) => post({ type: 'hardware-result', id: msg.id, info }),
        () => post({ type: 'hardware-result', id: msg.id, info: { gpuType: 'none' } })
      );
      break;
    case 'load':
      loadModel(msg.params).then(
        (info) => post({ type: 'load-result', id: msg.id, ok: true, info }),
        (err: unknown) => {
          const tag = (err as { rico?: 'oom' | 'bad-file' } | undefined)?.rico;
          post({ type: 'load-result', id: msg.id, ok: false, error: errMessage(err), code: tag ?? 'other' });
        }
      );
      break;
    case 'unload':
      unloadModel().finally(() => post({ type: 'unload-result', id: msg.id }));
      break;
    case 'generate':
      void generate(msg);
      break;
    case 'abort':
      aborts.get(msg.requestId)?.abort();
      break;
    case 'shutdown':
      void shutdown();
      break;
  }
});

process.on('uncaughtException', (err) => {
  console.error('[engine] uncaughtException', err);
  for (const requestId of aborts.keys()) post({ type: 'error', requestId, message: errMessage(err), code: 'other' });
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[engine] unhandledRejection', err);
});

post({ type: 'ready' });
