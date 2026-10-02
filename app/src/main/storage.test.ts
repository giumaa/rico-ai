import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Chat } from '../shared/api';
import {
  atomicWriteFile,
  atomicWriteJson,
  ChatStore,
  DEFAULT_SETTINGS,
  isSafeId,
  readJsonOr,
  sanitizeChat,
  sanitizeSettings,
  SettingsStore
} from './storage';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rico-storage-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const chat = (id: string, updatedAt = 1, extra: Partial<Chat> = {}): Chat => ({
  id,
  title: `chat ${id}`,
  messages: [{ id: 'm1', role: 'user', content: 'مرحبا', createdAt: 1 }],
  createdAt: 1,
  updatedAt,
  ...extra
});

describe('atomic writes', () => {
  it('writes the file and leaves no temp files behind', async () => {
    const file = join(dir, 'nested', 'a.json');
    await atomicWriteJson(file, { hello: 'world' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ hello: 'world' });
    expect((await readdir(join(dir, 'nested'))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('replaces existing content completely', async () => {
    const file = join(dir, 'a.json');
    await atomicWriteFile(file, 'x'.repeat(10_000));
    await atomicWriteFile(file, 'short');
    expect(await readFile(file, 'utf8')).toBe('short');
  });

  it('serialises concurrent writes to the same file (always valid JSON, last write wins)', async () => {
    const file = join(dir, 'c.json');
    const writes = Array.from({ length: 25 }, (_, i) => atomicWriteJson(file, { n: i, pad: 'z'.repeat(5000) }));
    await Promise.all(writes);
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { n: number };
    expect(parsed.n).toBe(24);
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps the old file intact when a write fails', async () => {
    const file = join(dir, 'keep.json');
    await atomicWriteJson(file, { ok: true });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(atomicWriteJson(file, circular)).rejects.toThrow();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ok: true });
  });
});

describe('readJsonOr', () => {
  it('returns the fallback for a missing file', async () => {
    expect(await readJsonOr(join(dir, 'nope.json'), { a: 1 })).toEqual({ a: 1 });
  });

  it('moves a corrupt file aside instead of deleting it', async () => {
    const file = join(dir, 'bad.json');
    await writeFile(file, '{ broken', 'utf8');
    expect(await readJsonOr(file, 'fallback')).toBe('fallback');
    const names = await readdir(dir);
    expect(names.some((n) => n.startsWith('bad.json.corrupt-'))).toBe(true);
  });

  it('tolerates a UTF-8 BOM', async () => {
    const file = join(dir, 'bom.json');
    await writeFile(file, '﻿{"a":1}', 'utf8');
    expect(await readJsonOr(file, null)).toEqual({ a: 1 });
  });
});

describe('settings', () => {
  it('sanitizeSettings fills defaults and clamps values', () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    const s = sanitizeSettings({ theme: 'neon', temperature: 99, maxTokens: -5, fontScale: 0, perfMode: 'max', dialect: 'msa' });
    expect(s.theme).toBe('system');
    expect(s.temperature).toBe(2);
    expect(s.maxTokens).toBe(16);
    expect(s.fontScale).toBe(0.75);
    expect(s.perfMode).toBe('max');
    expect(s.dialect).toBe('msa');
  });

  it('persists patches across store instances and never stores unknown keys', async () => {
    const file = join(dir, 'settings.json');
    const a = new SettingsStore(file);
    expect(await a.get()).toEqual(DEFAULT_SETTINGS);
    await a.set({ theme: 'dark', uiLang: 'en', activeModelId: 'rico-lite', ...({ evil: 1 } as object) });
    const b = new SettingsStore(file);
    const got = await b.get();
    expect(got.theme).toBe('dark');
    expect(got.uiLang).toBe('en');
    expect(got.activeModelId).toBe('rico-lite');
    expect(JSON.parse(await readFile(file, 'utf8')).evil).toBeUndefined();
  });

  it('can clear the active model', async () => {
    const s = new SettingsStore(join(dir, 'settings.json'));
    await s.set({ activeModelId: 'x' });
    const cleared = await s.set({ activeModelId: undefined });
    expect(cleared.activeModelId).toBeUndefined();
  });
});

describe('chat validation', () => {
  it('accepts only safe ids', () => {
    expect(isSafeId('abc-123_X')).toBe(true);
    for (const bad of ['', '../x', 'a/b', 'a\\b', 'a.b', 'x'.repeat(81), 5, null]) expect(isSafeId(bad)).toBe(false);
  });

  it('sanitizeChat rejects garbage and normalises messages', () => {
    expect(sanitizeChat(null)).toBeNull();
    expect(sanitizeChat({ id: '../etc' })).toBeNull();
    const c = sanitizeChat({ id: 'ok', messages: [{ role: 'weird', content: 5 }, 'x'] });
    expect(c?.messages).toHaveLength(1);
    expect(c?.messages[0]).toMatchObject({ role: 'user', content: '' });
  });
});

describe('ChatStore', () => {
  it('saves, lists (newest first), gets and deletes chats', async () => {
    const store = new ChatStore(join(dir, 'chats'));
    await store.save(chat('a', 10));
    await store.save(chat('b', 30, { pinned: true }));
    await store.save(chat('c', 20));
    const list = await store.list();
    expect(list.map((c) => c.id)).toEqual(['b', 'c', 'a']);
    expect(list[0]).toMatchObject({ id: 'b', pinned: true });
    expect((await store.get('a'))?.messages[0]?.content).toBe('مرحبا');
    await store.delete('c');
    expect((await store.list()).map((c) => c.id)).toEqual(['b', 'a']);
    expect(await store.get('c')).toBeNull();
  });

  it('survives a restart (index rebuilt from disk) and ignores corrupt files', async () => {
    const chats = join(dir, 'chats');
    const first = new ChatStore(chats);
    await first.save(chat('keep', 5));
    await writeFile(join(chats, 'junk.json'), '{ nope', 'utf8');
    const second = new ChatStore(chats);
    expect((await second.list()).map((c) => c.id)).toEqual(['keep']);
  });

  it('updates an existing chat in place', async () => {
    const store = new ChatStore(join(dir, 'chats'));
    await store.save(chat('a', 1));
    await store.save(chat('a', 2, { title: 'renamed' }));
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: 'renamed', updatedAt: 2 });
  });

  it('deleteAll wipes every chat', async () => {
    const chats = join(dir, 'chats');
    const store = new ChatStore(chats);
    await store.save(chat('a'));
    await store.save(chat('b'));
    await store.deleteAll();
    expect(await store.list()).toEqual([]);
    expect(await readdir(chats)).toEqual([]);
    await store.save(chat('c'));
    expect((await store.list()).map((c) => c.id)).toEqual(['c']);
  });

  it('refuses unsafe ids (no path traversal)', async () => {
    const store = new ChatStore(join(dir, 'chats'));
    await expect(store.save(chat('../evil'))).rejects.toThrow();
    expect(await store.get('../evil')).toBeNull();
    await store.delete('../evil'); // must not throw or touch anything
  });
});

describe('chats with images', () => {
  it('persists user images and drops invalid / assistant ones', async () => {
    const store = new ChatStore(join(dir, 'chats'));
    const image = { id: 'img1', mime: 'image/jpeg', dataBase64: 'QUJDREVGR0g=', name: 'a.jpg', width: 10, height: 20 };
    await store.save({
      id: 'c',
      title: 'with image',
      createdAt: 1,
      updatedAt: 1,
      messages: [
        { id: 'm1', role: 'user', content: 'look', createdAt: 1, images: [image, { id: 'bad', mime: 'image/gif', dataBase64: 'QUJD' }] },
        { id: 'm2', role: 'assistant', content: 'nice', createdAt: 2, images: [image] }
      ]
    } as unknown as Chat);
    const loaded = await store.get('c');
    expect(loaded?.messages[0]?.images).toEqual([image]);
    expect(loaded?.messages[1]?.images).toBeUndefined();
    // survives a restart
    expect((await new ChatStore(join(dir, 'chats')).get('c'))?.messages[0]?.images).toHaveLength(1);
  });
});

describe('ChatStore index.json (review item 25)', () => {
  const big = 'A'.repeat(200_000);
  const withImage = (id: string, updatedAt: number): Chat =>
    ({ id, title: `t-${id}`, createdAt: 1, updatedAt, messages: [{ id: 'm', role: 'user', content: 'x', createdAt: 1, images: [{ id: 'i', mime: 'image/png', dataBase64: big }] }] }) as unknown as Chat;

  it('writes an index of summaries and a restart lists chats from it without reading chat files', async () => {
    const chats = join(dir, 'chats');
    const first = new ChatStore(chats);
    await first.save(withImage('a', 10));
    await first.save(withImage('b', 20));
    const idx = JSON.parse(await readFile(join(chats, 'index.json'), 'utf8')) as { version: number; chats: Array<{ id: string }> };
    expect(idx.version).toBe(1);
    expect(idx.chats.map((c) => c.id).sort()).toEqual(['a', 'b']);
    expect(JSON.stringify(idx)).not.toContain('AAAA'); // summaries only: no message bodies / images

    // corrupt one chat file: a restart must still list it (it is served from the index, nothing is parsed)
    await writeFile(join(chats, 'a.json'), '{ not json', 'utf8');
    const second = new ChatStore(chats);
    expect((await second.list()).map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('reconciles with the directory: picks up unknown files, drops entries whose file vanished, rebuilds a corrupt index', async () => {
    const chats = join(dir, 'chats');
    const s1 = new ChatStore(chats);
    await s1.save(withImage('a', 10));
    await s1.save(withImage('b', 20));
    await rm(join(chats, 'a.json'));
    await writeFile(join(chats, 'c.json'), JSON.stringify(withImage('c', 30)), 'utf8'); // e.g. restored from a backup
    expect((await new ChatStore(chats).list()).map((c) => c.id)).toEqual(['c', 'b']);

    await writeFile(join(chats, 'index.json'), '{ broken', 'utf8');
    expect((await new ChatStore(chats).list()).map((c) => c.id)).toEqual(['c', 'b']);
  });

  it('reserves "index" as an id and keeps the index in sync on delete', async () => {
    const chats = join(dir, 'chats');
    const store = new ChatStore(chats);
    await expect(store.save(withImage('index', 1))).rejects.toThrow();
    await store.save(withImage('a', 1));
    await store.delete('a');
    expect((await new ChatStore(chats).list())).toEqual([]);
  });
});
