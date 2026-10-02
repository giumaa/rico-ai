// JSON storage in userData: atomic writes, one file per chat, validated settings.
// No Electron imports — callers pass directories — so everything here is unit-testable.

import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Chat, ChatMessage, ChatSummary, Settings } from '../shared/api';
import { sanitizeImages } from './images';

// ---------------------------------------------------------------------------------------------------------
// Atomic file writes

const writeQueues = new Map<string, Promise<unknown>>();

/** Serialises async work per key so concurrent writes to the same file cannot interleave. */
function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
  const tracked = next.catch(() => undefined);
  writeQueues.set(key, tracked);
  void tracked.then(() => {
    if (writeQueues.get(key) === tracked) writeQueues.delete(key);
  });
  return next;
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  const retriable = new Set(['EPERM', 'EBUSY', 'EACCES']);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !retriable.has(code)) throw err;
      // Windows: antivirus / indexers briefly lock freshly written files.
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** Writes via a temp file in the same directory, fsyncs, then renames over the destination. */
export function atomicWriteFile(path: string, data: string | Uint8Array): Promise<void> {
  return enqueue(path, async () => {
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(tmp, 'w');
      await handle.writeFile(data);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await renameWithRetry(tmp, path);
    } catch (err) {
      if (handle) await handle.close().catch(() => undefined);
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  });
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  return atomicWriteFile(path, JSON.stringify(value, null, 2));
}

/** Reads JSON; returns `fallback` when missing. A corrupt file is moved aside (never silently deleted). */
export async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(text.replace(/^﻿/, '')) as T;
  } catch {
    await fs.rename(path, `${path}.corrupt-${Date.now()}`).catch(() => undefined);
    return fallback;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Settings

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  uiLang: 'ar',
  perfMode: 'eco',
  temperature: 0.7,
  maxTokens: 1024,
  dialect: 'libyan',
  fontScale: 1.0
};

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Validates/normalises an arbitrary object into Settings, filling defaults. */
export function sanitizeSettings(raw: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Settings = {
    theme: oneOf(r.theme, ['system', 'dark', 'light'], base.theme),
    uiLang: oneOf(r.uiLang, ['ar', 'en'], base.uiLang),
    perfMode: oneOf(r.perfMode, ['eco', 'balanced', 'max'], base.perfMode),
    temperature: clampNum(r.temperature, 0, 2, base.temperature),
    maxTokens: Math.round(clampNum(r.maxTokens, 16, 16384, base.maxTokens)),
    dialect: oneOf(r.dialect, ['libyan', 'msa', 'auto'], base.dialect),
    fontScale: clampNum(r.fontScale, 0.75, 1.75, base.fontScale)
  };
  const activeModelId = 'activeModelId' in r ? r.activeModelId : base.activeModelId;
  if (typeof activeModelId === 'string' && activeModelId.length > 0 && activeModelId.length <= 200) {
    out.activeModelId = activeModelId;
  }
  return out;
}

export class SettingsStore {
  private cache: Settings | undefined;

  constructor(private readonly file: string) {}

  async get(): Promise<Settings> {
    if (!this.cache) {
      const raw = await readJsonOr<unknown>(this.file, {});
      this.cache = sanitizeSettings(raw);
    }
    return { ...this.cache };
  }

  async set(patch: Partial<Settings>): Promise<Settings> {
    const current = await this.get();
    const merged: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(patch ?? {})) merged[k] = v;
    const next = sanitizeSettings(merged, current);
    this.cache = next;
    await atomicWriteJson(this.file, next);
    return { ...next };
  }
}

// ---------------------------------------------------------------------------------------------------------
// Chats

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/** `chats/index.json` is the summary index, so it can never be a chat id. */
const INDEX_FILE = 'index.json';

export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id) && id !== 'index';
}

function toRole(r: unknown): ChatMessage['role'] {
  return r === 'assistant' || r === 'system' ? r : 'user';
}

/** Validates a chat coming over IPC. Returns null if it is unusable. */
export function sanitizeChat(raw: unknown): Chat | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isSafeId(r.id)) return null;
  const now = Date.now();
  const messages: ChatMessage[] = Array.isArray(r.messages)
    ? r.messages
        .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
        .map((m, i) => {
          const role = toRole(m.role);
          const msg: ChatMessage = {
            id: typeof m.id === 'string' && m.id ? m.id : `m${i}-${now}`,
            role,
            content: typeof m.content === 'string' ? m.content : '',
            createdAt: typeof m.createdAt === 'number' && Number.isFinite(m.createdAt) ? m.createdAt : now
          };
          const images = role === 'user' ? sanitizeImages(m.images) : [];
          if (images.length > 0) msg.images = images;
          return msg;
        })
    : [];
  const chat: Chat = {
    id: r.id,
    title: typeof r.title === 'string' ? r.title.slice(0, 300) : '',
    messages,
    createdAt: typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : now
  };
  if (typeof r.pinned === 'boolean') chat.pinned = r.pinned;
  return chat;
}

function summarize(chat: Chat): ChatSummary {
  const s: ChatSummary = { id: chat.id, title: chat.title, updatedAt: chat.updatedAt };
  if (chat.pinned) s.pinned = true;
  return s;
}

export class ChatStore {
  private index: Map<string, ChatSummary> | undefined;

  constructor(private readonly dir: string) {}

  private fileFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /**
   * The list of chats comes from `index.json` (summaries only), so startup never parses every chat file (they can hold
   * megabytes of base64 images). Only chat files the index does not know are read; entries whose file is gone are
   * dropped; a missing/corrupt index is rebuilt from the directory.
   */
  private async loadIndex(): Promise<Map<string, ChatSummary>> {
    if (this.index) return this.index;
    let names: string[] = [];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      /* directory not created yet */
    }
    const present = names.filter((n) => n.endsWith('.json') && n !== INDEX_FILE).map((n) => n.slice(0, -5)).filter(isSafeId);

    const saved = await readJsonOr<{ version?: number; chats?: unknown } | null>(join(this.dir, INDEX_FILE), null);
    const known = new Map<string, ChatSummary>();
    if (saved && saved.version === 1 && Array.isArray(saved.chats)) {
      for (const c of saved.chats as Array<Partial<ChatSummary>>) {
        if (c && isSafeId(c.id) && typeof c.title === 'string' && typeof c.updatedAt === 'number') {
          known.set(c.id, { id: c.id, title: c.title, updatedAt: c.updatedAt, ...(c.pinned ? { pinned: true } : {}) });
        }
      }
    }

    const index = new Map<string, ChatSummary>();
    let changed = !saved || known.size !== present.length;
    for (const id of present) {
      const hit = known.get(id);
      if (hit) {
        index.set(id, hit);
        continue;
      }
      changed = true;
      const chat = sanitizeChat(await readJsonOr<unknown>(this.fileFor(id), null));
      if (chat && chat.id === id) index.set(id, summarize(chat));
    }
    this.index = index;
    if (changed && present.length + known.size > 0) await this.persistIndex().catch(() => undefined);
    return index;
  }

  private persistIndex(): Promise<void> {
    const chats = [...(this.index ?? new Map<string, ChatSummary>()).values()];
    return atomicWriteJson(join(this.dir, INDEX_FILE), { version: 1, chats });
  }

  async list(): Promise<ChatSummary[]> {
    const index = await this.loadIndex();
    return [...index.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<Chat | null> {
    if (!isSafeId(id)) return null;
    const chat = sanitizeChat(await readJsonOr<unknown>(this.fileFor(id), null));
    return chat && chat.id === id ? chat : null;
  }

  async save(raw: unknown): Promise<void> {
    const chat = sanitizeChat(raw);
    if (!chat) throw new Error('Invalid chat');
    const index = await this.loadIndex();
    await atomicWriteJson(this.fileFor(chat.id), chat);
    index.set(chat.id, summarize(chat));
    await this.persistIndex();
  }

  async delete(id: string): Promise<void> {
    if (!isSafeId(id)) return;
    const index = await this.loadIndex();
    await enqueue(this.fileFor(id), () => fs.rm(this.fileFor(id), { force: true }));
    index.delete(id);
    await this.persistIndex();
  }

  async deleteAll(): Promise<void> {
    await this.loadIndex();
    let names: string[] = [];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      names = [];
    }
    await Promise.all(
      names.map((n) => enqueue(join(this.dir, n), () => fs.rm(join(this.dir, n), { force: true, recursive: true })))
    );
    this.index = new Map();
  }
}
