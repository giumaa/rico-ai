// Persona injection: system prompt + optional few-shot turns + dialect variant + history normalisation.
// Pure logic lives at the top (unit-tested); the small fs loader is at the bottom.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage, ImageAttachment, Settings } from '../shared/api';
import { MAX_IMAGES_IN_CONTEXT, sanitizeImages } from './images';

export interface Fewshot {
  user: string;
  assistant: string;
}

export interface DialectOverrides {
  msa?: string;
  auto?: string;
}

export interface PersonaFiles {
  systemPrompt?: string;
  fewshots?: Fewshot[];
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

const MAX_FEWSHOTS = 12;

export function parseFewshots(raw: unknown): Fewshot[] {
  if (!Array.isArray(raw)) return [];
  const out: Fewshot[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { user, assistant } = item as Record<string, unknown>;
    if (typeof user === 'string' && typeof assistant === 'string' && user.trim() && assistant.trim()) {
      out.push({ user: user.trim(), assistant: assistant.trim() });
    }
  }
  return out;
}

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
 * Only the most recent MAX_IMAGES_IN_CONTEXT images are sent; older ones are replaced by a short marker.
 */
export function normalizeHistory(messages: ReadonlyArray<Pick<ChatMessage, 'role' | 'content' | 'images'>>): Turn[] {
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
  limitImages(turns, MAX_IMAGES_IN_CONTEXT);
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

/** Picks the leading few-shot pairs that fit a character budget derived from the context window. */
export function selectFewshots(fewshots: readonly Fewshot[], contextSize?: number): Fewshot[] {
  // Arabic averages ~2.4 chars/token; spend at most ~25% of the context on examples.
  const budget = contextSize && contextSize > 0 ? Math.floor(contextSize * 0.6) : 8000;
  const out: Fewshot[] = [];
  let used = 0;
  for (const f of fewshots.slice(0, MAX_FEWSHOTS)) {
    const cost = f.user.length + f.assistant.length;
    if (used + cost > budget) break;
    out.push(f);
    used += cost;
  }
  return out;
}

export interface AssembleInput {
  files: PersonaFiles;
  dialect: Settings['dialect'];
  history: ReadonlyArray<Pick<ChatMessage, 'role' | 'content' | 'images'>>;
  contextSize?: number;
}

export interface AssembledPrompt {
  systemPrompt: string;
  /** few-shot turns followed by the visible history; always ends with a user turn (or is empty). */
  turns: Turn[];
}

export function assemblePrompt(input: AssembleInput): AssembledPrompt {
  const systemPrompt = buildSystemPrompt(input.files, input.dialect);
  const history = normalizeHistory(input.history);
  const shots = selectFewshots(input.files.fewshots ?? [], input.contextSize);
  const turns: Turn[] = [];
  for (const s of shots) {
    turns.push({ role: 'user', content: s.user }, { role: 'assistant', content: s.assistant });
  }
  turns.push(...history);
  return { systemPrompt, turns: history.length === 0 ? [] : turns };
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
  const [prompt, shots, overrides] = await Promise.all([
    readTextIfExists(join(dir, 'system-prompt.md')),
    readJsonIfExists(join(dir, 'fewshots.json')),
    readJsonIfExists(join(dir, 'dialect-overrides.json'))
  ]);
  return {
    systemPrompt: prompt?.replace(/^﻿/, ''),
    fewshots: parseFewshots(shots),
    dialectOverrides: parseDialectOverrides(overrides)
  };
}
