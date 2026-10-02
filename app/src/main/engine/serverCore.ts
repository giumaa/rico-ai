// Pure logic for the llama-server sidecar: command-line, request payload, SSE parsing, history trimming,
// binary lookup and exit classification. No I/O, no Electron — fully unit-tested.
//
// Flags below were verified against the llama.cpp server README of the pinned release
// (scripts/fetch-llama-server.mjs: DEFAULT_TAG).

import { dataUri } from '../images';
import type { Turn } from '../persona';
import type { Sampling } from './protocol';

// ---------------------------------------------------------------------------------------------------------
// Command line

export interface ServerArgsInput {
  modelPath: string;
  mmprojPath?: string;
  port: number;
  contextSize: number;
  threads: number;
  batchSize: number;
  /** 0 = CPU only, number = exact layers, 'auto' = let llama-server fit. */
  gpuLayers: 'auto' | number;
  /** false -> keep the vision projector on the CPU (saves VRAM; used for eco mode on small cards). */
  mmprojOffload: boolean;
  /** Caps tokens per image on small context windows (dynamic-resolution vision models only). */
  imageMaxTokens?: number;
  /** Host RAM for the prompt cache. The default (8 GiB) is far too large for an 8 GB laptop. */
  cacheRamMiB: number;
}

/**
 * The API key is NOT on the command line (it would be visible to other local processes): it is passed through the
 * LLAMA_API_KEY environment variable instead.
 */
export function buildServerArgs(i: ServerArgsInput): string[] {
  // Vision models need n_ubatch >= the tokens of one image (non-causal attention over the whole image), so the
  // gentle eco batch of 256 is raised to 1024 whenever a projector is loaded.
  const batch = i.mmprojPath ? Math.max(i.batchSize, 1024) : i.batchSize;
  const ubatch = i.mmprojPath ? 1024 : Math.min(batch, 512);
  const args = [
    '-m', i.modelPath,
    '--host', '127.0.0.1',
    '--port', String(i.port),
    '-c', String(i.contextSize),
    '-t', String(i.threads),
    '-tb', String(i.threads),
    '-b', String(batch),
    '-ub', String(ubatch),
    '-np', '1', // one conversation at a time: the whole context belongs to it
    '-ngl', i.gpuLayers === 'auto' ? 'auto' : String(Math.max(0, Math.floor(i.gpuLayers))),
    '--no-webui',
    '--no-slots',
    '--offline', // never touch the network (privacy promise)
    '--jinja',
    '--reasoning-budget', '0',
    '--chat-template-kwargs', '{"enable_thinking":false}',
    '--cache-ram', String(Math.max(0, Math.floor(i.cacheRamMiB))),
    '--ctx-checkpoints', '4',
    '--log-colors', 'off'
  ];
  if (i.mmprojPath) {
    args.push('--mmproj', i.mmprojPath);
    if (!i.mmprojOffload) args.push('--no-mmproj-offload');
    if (i.imageMaxTokens) args.push('--image-max-tokens', String(i.imageMaxTokens));
  }
  return args;
}

/** Environment of the sidecar: API key (never on argv), offline, and the bundled libraries on Linux. */
export function serverEnv(
  base: NodeJS.ProcessEnv,
  apiKey: string,
  exeDir: string,
  platform: NodeJS.Platform
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, LLAMA_API_KEY: apiKey, LLAMA_ARG_OFFLINE: '1' };
  if (platform === 'linux') {
    // The shared objects (libllama.so, libggml*.so, libmtmd.so) sit next to the executable.
    env.LD_LIBRARY_PATH = [exeDir, base.LD_LIBRARY_PATH].filter(Boolean).join(':');
  }
  return env;
}

// ---------------------------------------------------------------------------------------------------------
// Chat payload

export type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | OpenAiContentPart[];
}

export function toOpenAiMessages(systemPrompt: string, turns: readonly Turn[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: 'system', content: systemPrompt }];
  for (const t of turns) {
    if (t.role === 'user' && t.images && t.images.length > 0) {
      const parts: OpenAiContentPart[] = t.images.map((img) => ({ type: 'image_url', image_url: { url: dataUri(img) } }));
      if (t.content) parts.push({ type: 'text', text: t.content });
      out.push({ role: 'user', content: parts });
    } else {
      out.push({ role: t.role, content: t.content });
    }
  }
  return out;
}

export function buildChatPayload(i: { systemPrompt: string; turns: readonly Turn[]; sampling: Sampling }): Record<string, unknown> {
  return {
    model: 'rico',
    stream: true,
    stream_options: { include_usage: true },
    messages: toOpenAiMessages(i.systemPrompt, i.turns),
    temperature: i.sampling.temperature,
    top_p: 0.95,
    top_k: 40,
    min_p: 0.02,
    repeat_penalty: 1.05,
    max_tokens: i.sampling.maxTokens,
    cache_prompt: true,
    chat_template_kwargs: { enable_thinking: false }
  };
}

// ---------------------------------------------------------------------------------------------------------
// History trimming (context budget)

const CHARS_PER_TOKEN = 2.4; // Arabic-heavy text
export const IMAGE_TOKEN_ESTIMATE = 1100;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateTurnTokens(t: Turn): number {
  return estimateTokens(t.content) + 8 + (t.images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE;
}

/** Tokens available for the conversation after reserving room for the system prompt and the reply. */
export function conversationBudget(contextSize: number, maxTokens: number, systemPrompt: string): number {
  const reply = Math.min(maxTokens, Math.floor(contextSize * 0.4));
  return Math.max(256, contextSize - reply - estimateTokens(systemPrompt) - 64);
}

/**
 * Drops the oldest user/assistant pairs (few-shots first) until the estimate fits. The last turn is always kept.
 * Returns a new array; turns are shared, not cloned.
 */
export function trimTurnsToFit(turns: readonly Turn[], budgetTokens: number): Turn[] {
  const out = [...turns];
  const total = (): number => out.reduce((n, t) => n + estimateTurnTokens(t), 0);
  while (out.length > 1 && total() > budgetTokens) {
    // Remove a leading user turn together with its assistant reply so roles keep alternating.
    out.splice(0, out.length > 2 && out[1]?.role === 'assistant' ? 2 : 1);
    while (out.length > 1 && out[0]!.role !== 'user') out.shift();
  }
  return out;
}

/** Drops exactly one leading pair (used after the server reported a context overflow). Returns false if nothing is left to drop. */
export function dropOldestPair(turns: Turn[]): boolean {
  if (turns.length <= 1) return false;
  turns.splice(0, turns.length > 2 && turns[1]?.role === 'assistant' ? 2 : 1);
  while (turns.length > 1 && turns[0]!.role !== 'user') turns.shift();
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// SSE

export type SseEvent = { kind: 'json'; data: Record<string, unknown> } | { kind: 'done' };

/** Incremental Server-Sent-Events parser (handles chunk boundaries, CRLF, multi-line data). */
export class SseParser {
  private buf = '';

  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const events: SseEvent[] = [];
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buf);
      if (!m) break;
      const block = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      const ev = parseBlock(block);
      if (ev) events.push(ev);
    }
    return events;
  }

  flush(): SseEvent[] {
    const rest = this.buf.trim();
    this.buf = '';
    if (!rest) return [];
    const ev = parseBlock(rest);
    return ev ? [ev] : [];
  }
}

function parseBlock(block: string): SseEvent | null {
  const data = block
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data) return null;
  if (data.trim() === '[DONE]') return { kind: 'done' };
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed && typeof parsed === 'object' ? { kind: 'json', data: parsed as Record<string, unknown> } : null;
  } catch {
    return null;
  }
}

export interface ChunkInfo {
  /** Visible answer text (reasoning_content is deliberately ignored). */
  content?: string;
  finishReason?: string | null;
  tokensPerSecond?: number;
  completionTokens?: number;
  error?: { message: string; type?: string };
}

/** Extracts what Rico needs from one OpenAI-style streaming chunk of llama-server. */
export function readChunk(json: Record<string, unknown>): ChunkInfo {
  const out: ChunkInfo = {};
  const err = json.error as { message?: unknown; type?: unknown } | undefined;
  if (err && typeof err === 'object') {
    out.error = { message: typeof err.message === 'string' ? err.message : 'Unknown server error' };
    if (typeof err.type === 'string') out.error.type = err.type;
    return out;
  }
  const choice = (json.choices as Array<Record<string, unknown>> | undefined)?.[0];
  const delta = choice?.delta as { content?: unknown } | undefined;
  if (delta && typeof delta.content === 'string' && delta.content.length > 0) out.content = delta.content;
  if (choice && 'finish_reason' in choice) out.finishReason = (choice.finish_reason as string | null) ?? null;
  const timings = json.timings as { predicted_per_second?: unknown; predicted_n?: unknown } | undefined;
  if (timings && typeof timings.predicted_per_second === 'number' && Number.isFinite(timings.predicted_per_second)) {
    out.tokensPerSecond = Math.round(timings.predicted_per_second * 10) / 10;
  }
  const usage = json.usage as { completion_tokens?: unknown } | undefined;
  if (usage && typeof usage.completion_tokens === 'number') out.completionTokens = usage.completion_tokens;
  return out;
}

/** llama-server answers an oversized prompt with HTTP 400 and `exceed_context_size_error`. */
export function isContextOverflow(status: number, body: string): boolean {
  if (status !== 400) return false;
  return /exceed_context_size_error|exceeds the available context size|context size/i.test(body);
}

export function errorMessageFromBody(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown } | string };
    if (typeof j.error === 'string') return j.error;
    if (j.error && typeof j.error.message === 'string') return j.error.message;
  } catch {
    /* not JSON */
  }
  return body.trim().slice(0, 300) || 'Unknown server error';
}

// ---------------------------------------------------------------------------------------------------------
// Binaries

export type ServerVariant = 'vulkan' | 'cpu' | 'metal' | 'default';

/** Directory name used by scripts/fetch-llama-server.mjs and electron-builder (${os}-${arch}). */
export function platformDirName(platform: NodeJS.Platform, arch: string): string | null {
  const os = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : platform === 'linux' ? 'linux' : null;
  if (!os) return null;
  if (!(arch === 'x64' || (arch === 'arm64' && os === 'mac'))) return null;
  return `${os}-${arch}`;
}

export function serverExecutableName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'llama-server.exe' : 'llama-server';
}

/** Relative paths (under the bin root) of the llama-server builds to try, best first. */
export function serverBinaryCandidates(platform: NodeJS.Platform, arch: string, preferCpu: boolean): string[] {
  const dir = platformDirName(platform, arch);
  if (!dir) return [];
  const exe = serverExecutableName(platform);
  const variants: ServerVariant[] =
    platform === 'darwin' ? (arch === 'arm64' ? ['metal'] : ['default']) : preferCpu ? ['cpu', 'vulkan'] : ['vulkan', 'cpu'];
  return variants.map((v) => `${dir}/${v}/${exe}`);
}

// ---------------------------------------------------------------------------------------------------------
// Exit classification

/** NTSTATUS 0xC0E90002 / Win32 4551: "An Application Control policy has blocked this file." */
export const WINDOWS_APP_CONTROL_EXIT_CODES = [0xc0e90002, 0xc0e90002 - 0x100000000];

/** llama-server could not bind its listening socket (the port was taken by another process in the meantime). */
export function isPortCollision(stderrTail: string): boolean {
  return /bind|address already in use/i.test(stderrTail);
}

export function classifyServerExit(code: number | null, stderrTail: string): 'blocked' | 'oom' | 'bad-file' | 'crashed' {
  if (code !== null && WINDOWS_APP_CONTROL_EXIT_CODES.includes(code)) return 'blocked';
  if (/application control|smart app control|blocked by (?:your )?(?:administrator|policy|antivirus)/i.test(stderrTail)) return 'blocked';
  if (/out of memory|failed to allocate|errooutofdevicememory|erroroutofdevicememory|insufficient memory|unable to allocate|cudamalloc failed/i.test(stderrTail)) return 'oom';
  if (/failed to load model|error loading model|invalid magic|unknown model architecture|failed to open gguf|not a valid gguf/i.test(stderrTail)) return 'bad-file';
  return 'crashed';
}
