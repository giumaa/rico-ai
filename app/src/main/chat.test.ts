import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebContents } from 'electron';
import { IPC } from '../shared/ipc';
import { ChatController } from './chat';
import type { LoadedInfo } from './engine/protocol';
import type { GenerateInput } from './engine/types';
import { DEFAULT_SETTINGS } from './storage';

const img = (id: string) => ({ id, mime: 'image/jpeg' as const, dataBase64: 'QUJDREVGR0g=' });

describe('ChatController: system prompt date line, image limits and vision errors', () => {
  let dir: string;
  let info: LoadedInfo | undefined;
  let sent: Array<{ channel: string; payload: Record<string, unknown> }>;
  let generated: GenerateInput[];

  const sender = {
    isDestroyed: () => false,
    send: (channel: string, payload: Record<string, unknown>) => sent.push({ channel, payload })
  } as unknown as WebContents;

  const make = (): ChatController =>
    new ChatController({
      host: {
        getLoadedInfo: () => info,
        abort: () => undefined,
        generate: (_id: string, req: GenerateInput, handlers: { onDone(e: { text: string; stopped: boolean }): void }) => {
          generated.push(req);
          handlers.onDone({ text: 'ok', stopped: false });
        }
      } as never,
      engine: { ensureLoaded: async () => undefined } as never,
      settings: { get: async () => ({ ...DEFAULT_SETTINGS }) } as never,
      personaDir: dir,
      lang: () => 'ar'
    });

  const run = async (messages: Array<{ role: 'user' | 'assistant'; content: string; images?: ReturnType<typeof img>[] }>): Promise<void> => {
    await make().generate(sender, { chatId: 'c', messages });
    for (let i = 0; i < 100 && !sent.some((s) => s.channel === IPC.evChatDone || s.channel === IPC.evChatError); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rico-chat-'));
    await writeFile(join(dir, 'system-prompt.md'), 'أنت ريكو.', 'utf8');
    sent = [];
    generated = [];
    info = { contextSize: 8192, threads: 4, gpuLayers: 0, gpu: 'none', vision: true, engine: 'llama-server' };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends the local date line to the system prompt and sends only the visible history', async () => {
    await run([{ role: 'user', content: 'مرحبا' }]);
    expect(generated).toHaveLength(1);
    expect(generated[0]!.systemPrompt).toMatch(/^أنت ريكو\.\n\nتاريخ اليوم حسب جهازك: \d{4}-\d{2}-\d{2}$/);
    expect(generated[0]!.turns).toEqual([{ role: 'user', content: 'مرحبا' }]);
  });

  it('rejects early, in Libyan Arabic, when a message carries more images than this context window allows', async () => {
    info = { ...info!, contextSize: 4096 }; // 8 GB machine: 2 images max
    await run([{ role: 'user', content: 'شن هذي؟', images: [img('a'), img('b'), img('c')] }]);
    expect(generated).toHaveLength(0);
    const err = sent.find((s) => s.channel === IPC.evChatError)!;
    expect(String(err.payload.message)).toContain('2 صور');
    expect(String(err.payload.message)).toContain('في الرسالة الواحدة');
  });

  it('accepts the maximum and trims older images to the same budget', async () => {
    info = { ...info!, contextSize: 4096 };
    await run([
      { role: 'user', content: 'one', images: [img('a'), img('b')] },
      { role: 'assistant', content: 'r' },
      { role: 'user', content: 'two', images: [img('c'), img('d')] }
    ]);
    expect(generated).toHaveLength(1);
    expect(generated[0]!.turns[0]!.images).toBeUndefined(); // only 2 images fit the window: the older pair is dropped
    expect(generated[0]!.turns[2]!.images).toHaveLength(2);
  });

  it('explains why images do not work: text-only model, blocked or missing engine', async () => {
    const cases: Array<[Partial<LoadedInfo>, RegExp]> = [
      [{ vision: false }, /ما يقراش الصور/],
      [{ vision: false, visionNote: 'blocked' }, /Smart App Control/],
      [{ vision: false, visionNote: 'unavailable' }, /موش موجود/],
      [{ vision: false, visionNote: 'projector' }, /mmproj/]
    ];
    for (const [patch, re] of cases) {
      sent = [];
      info = { ...info!, ...patch };
      await run([{ role: 'user', content: 'x', images: [img('a')] }]);
      expect(String(sent.find((s) => s.channel === IPC.evChatError)?.payload.message)).toMatch(re);
    }
    expect(generated).toHaveLength(0);
  });

  it('text-only chats are unaffected by vision problems', async () => {
    info = { ...info!, vision: false, visionNote: 'blocked' };
    await run([{ role: 'user', content: 'مرحبا' }]);
    expect(generated).toHaveLength(1);
  });
});
