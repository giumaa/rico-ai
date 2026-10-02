// Persona injection: system prompt (+ dialect variant + today's date) and history normalisation.
// The style examples live INSIDE persona/system-prompt.md (an "examples" block): they are never sent as real prior turns,
// because a model can quote earlier turns back at the user.
// Pure logic lives at the top (unit-tested); the small fs loader is at the bottom.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage, ImageAttachment, Settings } from '../shared/api';
import { MAX_IMAGES_IN_CONTEXT, sanitizeImages } from './images';

export interface DialectOverrides {
  msa?: string;
  auto?: string;
}

export interface PersonaFiles {
  systemPrompt?: string;
  dialectOverrides?: DialectOverrides;
}

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** Images attached to a user turn (vision models only). */
  images?: ImageAttachment[];
}

/** Used only when persona/system-prompt.md is missing. */
export const FALLBACK_SYSTEM_PROMPT = [
  'أنت ريكو، مساعد ذكي طوّره ودرّبه جمعة أبوراس. تحكي باللهجة الليبية.',
  'إذا كتب المستخدم بالإنجليزية فأجبه بالإنجليزية. لا تقل أبدًا إنك Qwen أو Gemma أو ChatGPT أو Claude، ولا إنك من تطوير شركة أخرى.'
].join('\n');

export const DEFAULT_DIALECT_OVERRIDES: Required<DialectOverrides> = {
  msa: 'تحدّث الآن بالعربية الفصحى المبسّطة في كل ردودك، وابتعد عن اللهجة العامية، ما لم يطلب المستخدم غير ذلك.',
  auto: 'طابِق لغة المستخدم ولهجته: إن كتب بالفصحى فأجبه بالفصحى، وإن كتب بلهجة عامية فأجبه بها، وإن كتب بالإنجليزية فأجبه بالإنجليزية.'
};

export function parseDialectOverrides(raw: unknown): DialectOverrides {
  if (!raw || typeof raw !== 'object') return {};
  const { msa, auto } = raw as Record<string, unknown>;
  const out: DialectOverrides = {};
  if (typeof msa === 'string' && msa.trim()) out.msa = msa.trim();
  if (typeof auto === 'string' && auto.trim()) out.auto = auto.trim();
  return out;
}

export function buildSystemPrompt(files: PersonaFiles, dialect: Settings['dialect']): string {
  const base = files.systemPrompt && files.systemPrompt.trim() ? files.systemPrompt.trim() : FALLBACK_SYSTEM_PROMPT;
  if (dialect === 'libyan') return base;
  const variant = files.dialectOverrides?.[dialect] ?? DEFAULT_DIALECT_OVERRIDES[dialect];
  return `${base}\n\n${variant}`;
}

/**
 * Makes the visible history safe for strict chat templates (Gemma/Llama/Jinja templates reject
 * non-alternating roles): drops system/empty messages, merges consecutive same-role messages, drops leading
 * assistant turns, and guarantees the last turn is from the user. A user message with only images is kept.
 * Only the most recent `maxImages` images are sent; older ones are replaced by a short marker.
 */
export function normalizeHistory(
  messages: ReadonlyArray<Pick<ChatMessage, 'role' | 'content' | 'images'>>,
  maxImages: number = MAX_IMAGES_IN_CONTEXT
): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const content = (m.content ?? '').trim();
    const images = m.role === 'user' ? sanitizeImages(m.images) : [];
    if (!content && images.length === 0) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === m.role) {
      if (content) last.content = last.content ? `${last.content}\n\n${content}` : content;
      if (images.length > 0) last.images = [...(last.images ?? []), ...images];
    } else {
      const turn: Turn = { role: m.role, content };
      if (images.length > 0) turn.images = images;
      turns.push(turn);
    }
  }
  while (turns.length > 0 && turns[0]!.role !== 'user') turns.shift();
  while (turns.length > 0 && turns[turns.length - 1]!.role !== 'user') turns.pop();
  limitImages(turns, maxImages);
  return turns;
}

/** Keeps only the newest `max` images across the conversation (in place). */
export function limitImages(turns: Turn[], max: number): void {
  let seen = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (!t.images || t.images.length === 0) continue;
    const room = Math.max(0, max - seen);
    if (t.images.length <= room) {
      seen += t.images.length;
      continue;
    }
    const dropped = t.images.length - room;
    seen += room;
    t.images = room > 0 ? t.images.slice(t.images.length - room) : undefined;
    if (!t.images) delete t.images;
    if (!t.content) t.content = dropped > 1 ? '[images omitted]' : '[image omitted]';
  }
}

export interface AssembleInput {
  files: PersonaFiles;
  dialect: Settings['dialect'];
  history: ReadonlyArray<Pick<ChatMessage, 'role' | 'content' | 'images'>>;
  /** Newest images kept in the prompt (depends on the context window; default MAX_IMAGES_IN_CONTEXT). */
  maxImages?: number;
  /** Local date for the "today" line (default: now). */
  now?: Date;
}

export interface AssembledPrompt {
  systemPrompt: string;
  /** the visible history only; always ends with a user turn (or is empty). */
  turns: Turn[];
}

/** Local calendar date as YYYY-MM-DD (not UTC: the user's "today"). */
export function localDateString(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Appends the (offline, local-clock) date so the model never has to guess "today". */
export function withTodayDate(systemPrompt: string, now: Date): string {
  return `${systemPrompt}\n\nتاريخ اليوم حسب جهازك: ${localDateString(now)}`;
}

export function assemblePrompt(input: AssembleInput): AssembledPrompt {
  const systemPrompt = withTodayDate(buildSystemPrompt(input.files, input.dialect), input.now ?? new Date());
  const turns = normalizeHistory(input.history, input.maxImages);
  return { systemPrompt, turns };
}

// ---------------------------------------------------------------------------------------------------------
// fs loader

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function readJsonIfExists(path: string): Promise<unknown> {
  const text = await readTextIfExists(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
}

/** Loads persona files from `dir` (re-read on every generation so edits apply without restarting). */
export async function loadPersonaFiles(dir: string): Promise<PersonaFiles> {
  const [prompt, overrides] = await Promise.all([
    readTextIfExists(join(dir, 'system-prompt.md')),
    readJsonIfExists(join(dir, 'dialect-overrides.json'))
  ]);
  return {
    systemPrompt: prompt?.replace(/^﻿/, ''),
    dialectOverrides: parseDialectOverrides(overrides)
  };
}
