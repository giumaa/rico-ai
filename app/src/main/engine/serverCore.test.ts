import { describe, expect, it } from 'vitest';
import type { Turn } from '../persona';
import {
  buildChatPayload,
  buildServerArgs,
  classifyServerExit,
  conversationBudget,
  dropOldestPair,
  errorMessageFromBody,
  estimateTokens,
  isContextOverflow,
  platformDirName,
  readChunk,
  serverBinaryCandidates,
  SseParser,
  toOpenAiMessages,
  trimTurnsToFit
} from './serverCore';

const img = { id: 'i1', mime: 'image/jpeg' as const, dataBase64: 'AAAABBBBCCCC' };

describe('buildServerArgs', () => {
  const base = {
    modelPath: 'C:\\m\\model.gguf',
    port: 51234,
    contextSize: 4096,
    threads: 4,
    batchSize: 256,
    gpuLayers: 'auto' as const,
    mmprojOffload: true,
    cacheRamMiB: 0
  };

  it('binds to localhost only and never puts the API key on the command line', () => {
    const args = buildServerArgs(base);
    expect(args[args.indexOf('--host') + 1]).toBe('127.0.0.1');
    expect(args[args.indexOf('--port') + 1]).toBe('51234');
    expect(args).not.toContain('--api-key');
    expect(args).toContain('--offline');
    expect(args).toContain('--no-webui');
  });

  it('passes threads, context, batch and gpu layers', () => {
    const args = buildServerArgs({ ...base, gpuLayers: 21 });
    expect(args[args.indexOf('-t') + 1]).toBe('4');
    expect(args[args.indexOf('-tb') + 1]).toBe('4');
    expect(args[args.indexOf('-c') + 1]).toBe('4096');
    expect(args[args.indexOf('-b') + 1]).toBe('256');
    expect(args[args.indexOf('-ub') + 1]).toBe('256');
    expect(args[args.indexOf('-ngl') + 1]).toBe('21');
    expect(args[args.indexOf('-np') + 1]).toBe('1');
    expect(buildServerArgs(base)[buildServerArgs(base).indexOf('-ngl') + 1]).toBe('auto');
    expect(buildServerArgs({ ...base, batchSize: 1024 })[buildServerArgs({ ...base, batchSize: 1024 }).indexOf('-ub') + 1]).toBe('512');
  });

  it('only adds --mmproj for vision models, optionally keeping it off the GPU', () => {
    expect(buildServerArgs(base)).not.toContain('--mmproj');
    const v = buildServerArgs({ ...base, mmprojPath: 'C:\\m\\mmproj.gguf' });
    expect(v[v.indexOf('--mmproj') + 1]).toBe('C:\\m\\mmproj.gguf');
    expect(v).not.toContain('--no-mmproj-offload');
    expect(buildServerArgs({ ...base, mmprojPath: 'x', mmprojOffload: false })).toContain('--no-mmproj-offload');
  });

  it('limits the host RAM prompt cache and disables thinking', () => {
    const args = buildServerArgs({ ...base, cacheRamMiB: 512 });
    expect(args[args.indexOf('--cache-ram') + 1]).toBe('512');
    expect(args[args.indexOf('--reasoning-budget') + 1]).toBe('0');
    expect(args[args.indexOf('--chat-template-kwargs') + 1]).toBe('{"enable_thinking":false}');
  });
});

describe('OpenAI payload', () => {
  const turns: Turn[] = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'what is this?', images: [img, { ...img, id: 'i2', mime: 'image/png' }] }
  ];

  it('puts the system prompt first and turns images into image_url data URIs (images before text)', () => {
    const msgs = toOpenAiMessages('SYS', turns);
    expect(msgs[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(msgs[1]).toEqual({ role: 'user', content: 'hello' });
    const last = msgs[3]!;
    expect(Array.isArray(last.content)).toBe(true);
    const parts = last.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts.map((p) => p.type)).toEqual(['image_url', 'image_url', 'text']);
    expect(parts[0]!.image_url!.url).toBe('data:image/jpeg;base64,AAAABBBBCCCC');
    expect(parts[1]!.image_url!.url.startsWith('data:image/png;base64,')).toBe(true);
    expect(parts[2]!.text).toBe('what is this?');
  });

  it('supports an image-only user message', () => {
    const msgs = toOpenAiMessages('S', [{ role: 'user', content: '', images: [img] }]);
    const parts = msgs[1]!.content as Array<{ type: string }>;
    expect(parts.map((p) => p.type)).toEqual(['image_url']);
  });

  it('builds a streaming request with the sampling settings', () => {
    const p = buildChatPayload({ systemPrompt: 'S', turns, sampling: { temperature: 0.4, maxTokens: 321 } });
    expect(p.stream).toBe(true);
    expect(p.temperature).toBe(0.4);
    expect(p.max_tokens).toBe(321);
    expect(p.cache_prompt).toBe(true);
    expect((p.messages as unknown[]).length).toBe(4);
  });
});

describe('SseParser / readChunk', () => {
  const ev = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

  it('parses events split across arbitrary chunk boundaries', () => {
    const wire = ev({ choices: [{ delta: { content: 'مرحبا' } }] }) + ev({ choices: [{ delta: { content: ' بك' } }] }) + 'data: [DONE]\n\n';
    for (const size of [1, 3, 7, 50, wire.length]) {
      const p = new SseParser();
      const out = [];
      for (let i = 0; i < wire.length; i += size) out.push(...p.push(wire.slice(i, i + size)));
      out.push(...p.flush());
      expect(out.length).toBe(3);
      const texts = out.filter((e) => e.kind === 'json').map((e) => readChunk((e as { data: Record<string, unknown> }).data).content);
      expect(texts).toEqual(['مرحبا', ' بك']);
      expect(out[2]).toEqual({ kind: 'done' });
    }
  });

  it('handles CRLF line endings and ignores comments / invalid JSON', () => {
    const p = new SseParser();
    const out = p.push(': keep-alive\r\n\r\ndata: {broken\r\n\r\ndata: {"a":1}\r\n\r\n');
    expect(out).toEqual([{ kind: 'json', data: { a: 1 } }]);
  });

  it('reads content, finish reason, server tokens/sec and errors; ignores reasoning_content', () => {
    expect(readChunk({ choices: [{ delta: { content: 'x' }, finish_reason: null }] })).toEqual({ content: 'x', finishReason: null });
    expect(readChunk({ choices: [{ delta: { reasoning_content: 'thinking...' } }] }).content).toBeUndefined();
    expect(readChunk({ choices: [{ delta: {}, finish_reason: 'stop' }], timings: { predicted_per_second: 52.944 } })).toMatchObject({
      finishReason: 'stop',
      tokensPerSecond: 52.9
    });
    expect(readChunk({ usage: { completion_tokens: 12 } }).completionTokens).toBe(12);
    expect(readChunk({ error: { message: 'bad', type: 't' } }).error).toEqual({ message: 'bad', type: 't' });
  });

  it('recognises context overflow and extracts error messages', () => {
    const body = JSON.stringify({ error: { message: 'the request exceeds the available context size', type: 'exceed_context_size_error' } });
    expect(isContextOverflow(400, body)).toBe(true);
    expect(isContextOverflow(500, body)).toBe(false);
    expect(isContextOverflow(400, '{"error":{"message":"other"}}')).toBe(false);
    expect(errorMessageFromBody(body)).toContain('exceeds');
    expect(errorMessageFromBody('plain text')).toBe('plain text');
    expect(errorMessageFromBody('')).toBe('Unknown server error');
  });
});

describe('history trimming', () => {
  const mk = (n: number): Turn[] => {
    const t: Turn[] = [];
    for (let i = 0; i < n; i++) {
      t.push({ role: 'user', content: `u${i} ` + 'x'.repeat(200) }, { role: 'assistant', content: `a${i} ` + 'y'.repeat(200) });
    }
    t.push({ role: 'user', content: 'last question' });
    return t;
  };

  it('keeps everything when it fits', () => {
    const t = mk(2);
    expect(trimTurnsToFit(t, 100_000)).toEqual(t);
  });

  it('drops the oldest pairs first, keeps roles alternating and always keeps the last turn', () => {
    const t = mk(10);
    const out = trimTurnsToFit(t, 400);
    expect(out[out.length - 1]!.content).toBe('last question');
    expect(out[0]!.role).toBe('user');
    expect(out.length).toBeLessThan(t.length);
    for (let i = 1; i < out.length; i++) expect(out[i]!.role).not.toBe(out[i - 1]!.role);
    expect(trimTurnsToFit(t, 1).map((x) => x.content)).toEqual(['last question']);
  });

  it('counts images as expensive', () => {
    const withImg: Turn[] = [
      { role: 'user', content: 'a', images: [img] },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' }
    ];
    expect(trimTurnsToFit(withImg, 500).map((t) => t.content)).toEqual(['c']);
    expect(trimTurnsToFit(withImg, 5000)).toHaveLength(3);
  });

  it('dropOldestPair removes one pair at a time', () => {
    const t = mk(2);
    expect(dropOldestPair(t)).toBe(true);
    expect(t[0]!.content.startsWith('u1')).toBe(true);
    expect(dropOldestPair(t)).toBe(true);
    expect(t).toHaveLength(1);
    expect(dropOldestPair(t)).toBe(false);
  });

  it('reserves room for the reply and the system prompt', () => {
    expect(conversationBudget(4096, 1024, 'x'.repeat(240))).toBe(4096 - 1024 - 100 - 64);
    expect(conversationBudget(2048, 4096, '')).toBeGreaterThanOrEqual(256);
    expect(estimateTokens('a'.repeat(24))).toBe(10);
  });
});

describe('binary lookup', () => {
  it('maps platforms to the folder names used by the fetch script / electron-builder', () => {
    expect(platformDirName('win32', 'x64')).toBe('win-x64');
    expect(platformDirName('darwin', 'arm64')).toBe('mac-arm64');
    expect(platformDirName('darwin', 'x64')).toBe('mac-x64');
    expect(platformDirName('linux', 'x64')).toBe('linux-x64');
    expect(platformDirName('linux', 'arm64')).toBeNull();
    expect(platformDirName('win32', 'arm64')).toBeNull();
  });

  it('prefers Vulkan on Windows/Linux (CPU first when asked) and Metal on macOS', () => {
    expect(serverBinaryCandidates('win32', 'x64', false)).toEqual(['win-x64/vulkan/llama-server.exe', 'win-x64/cpu/llama-server.exe']);
    expect(serverBinaryCandidates('win32', 'x64', true)).toEqual(['win-x64/cpu/llama-server.exe', 'win-x64/vulkan/llama-server.exe']);
    expect(serverBinaryCandidates('linux', 'x64', false)[0]).toBe('linux-x64/vulkan/llama-server');
    expect(serverBinaryCandidates('darwin', 'arm64', false)).toEqual(['mac-arm64/metal/llama-server']);
    expect(serverBinaryCandidates('freebsd', 'x64', false)).toEqual([]);
  });
});

describe('classifyServerExit', () => {
  it('detects Windows application-control blocks (exit code and message)', () => {
    expect(classifyServerExit(0xc0e90002, '')).toBe('blocked');
    expect(classifyServerExit(-1058471934, '')).toBe('blocked');
    expect(classifyServerExit(1, 'An Application Control policy has blocked this file.')).toBe('blocked');
  });
  it('detects out-of-memory, bad model files and generic crashes', () => {
    expect(classifyServerExit(1, 'ggml_vulkan: ErrorOutOfDeviceMemory')).toBe('oom');
    expect(classifyServerExit(1, 'failed to allocate CPU buffer of size 123')).toBe('oom');
    expect(classifyServerExit(1, 'error loading model: invalid magic characters')).toBe('bad-file');
    expect(classifyServerExit(139, '')).toBe('crashed');
  });
});
