import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assemblePrompt,
  buildSystemPrompt,
  DEFAULT_DIALECT_OVERRIDES,
  FALLBACK_SYSTEM_PROMPT,
  loadPersonaFiles,
  normalizeHistory,
  localDateString,
  parseDialectOverrides,
  withTodayDate
} from './persona';

describe('buildSystemPrompt', () => {
  it('uses the persona file for the Libyan dialect as-is', () => {
    expect(buildSystemPrompt({ systemPrompt: '  أنت ريكو.  ' }, 'libyan')).toBe('أنت ريكو.');
  });

  it('falls back to the built-in Arabic prompt when the file is missing or empty', () => {
    expect(buildSystemPrompt({}, 'libyan')).toBe(FALLBACK_SYSTEM_PROMPT);
    expect(buildSystemPrompt({ systemPrompt: '   ' }, 'libyan')).toBe(FALLBACK_SYSTEM_PROMPT);
    expect(FALLBACK_SYSTEM_PROMPT).toContain('أنت ريكو، مساعد ذكي طوّره ودرّبه جمعة أبوراس. تحكي باللهجة الليبية.');
  });

  it('appends the msa / auto variant, preferring dialect-overrides.json', () => {
    const files = { systemPrompt: 'BASE', dialectOverrides: { msa: 'MSA-CUSTOM' } };
    expect(buildSystemPrompt(files, 'msa')).toBe('BASE\n\nMSA-CUSTOM');
    expect(buildSystemPrompt(files, 'auto')).toBe(`BASE\n\n${DEFAULT_DIALECT_OVERRIDES.auto}`);
  });
});

describe('normalizeHistory', () => {
  it('drops system and empty messages', () => {
    const out = normalizeHistory([
      { role: 'system', content: 'ignore me' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '   ' }
    ]);
    expect(out).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('merges consecutive same-role messages so templates stay alternating', () => {
    const out = normalizeHistory([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'c' },
      { role: 'user', content: 'd' }
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'a\n\nb' },
      { role: 'assistant', content: 'c' },
      { role: 'user', content: 'd' }
    ]);
  });

  it('removes leading assistant turns and trailing assistant turns', () => {
    const out = normalizeHistory([
      { role: 'assistant', content: 'welcome' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' }
    ]);
    expect(out).toEqual([{ role: 'user', content: 'q' }]);
  });

  it('returns [] when there is no user message', () => {
    expect(normalizeHistory([{ role: 'assistant', content: 'x' }])).toEqual([]);
  });
});

describe('parseDialectOverrides', () => {
  it('reads msa/auto strings only', () => {
    expect(parseDialectOverrides({ msa: 'm', auto: 3 })).toEqual({ msa: 'm' });
    expect(parseDialectOverrides(null)).toEqual({});
  });
});

describe('today line', () => {
  it('formats the LOCAL calendar date as YYYY-MM-DD', () => {
    expect(localDateString(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(localDateString(new Date(2026, 11, 31, 0, 0))).toBe('2026-12-31');
  });
  it('appends it to the system prompt', () => {
    expect(withTodayDate('SYS', new Date(2026, 9, 2))).toBe('SYS\n\nتاريخ اليوم حسب جهازك: 2026-10-02');
  });
});

describe('assemblePrompt', () => {
  const files = { systemPrompt: 'SYS' };
  const now = new Date(2026, 9, 2, 12, 0);

  it('sends ONLY the visible history as turns (style examples live in the system prompt, never as fake prior turns)', () => {
    const { systemPrompt, turns } = assemblePrompt({
      files,
      dialect: 'libyan',
      now,
      history: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' }
      ]
    });
    expect(systemPrompt).toBe('SYS\n\nتاريخ اليوم حسب جهازك: 2026-10-02');
    expect(turns.map((t) => `${t.role}:${t.content}`)).toEqual(['user:q1', 'assistant:a1', 'user:q2']);
  });

  it('returns no turns for an empty history (nothing to answer)', () => {
    expect(assemblePrompt({ files, dialect: 'libyan', history: [] }).turns).toEqual([]);
  });

  it('applies the dialect variant before the date line', () => {
    const { systemPrompt } = assemblePrompt({ files, dialect: 'msa', now, history: [{ role: 'user', content: 'x' }] });
    expect(systemPrompt.startsWith('SYS\n\n')).toBe(true);
    expect(systemPrompt).toContain(DEFAULT_DIALECT_OVERRIDES.msa);
    expect(systemPrompt.endsWith('تاريخ اليوم حسب جهازك: 2026-10-02')).toBe(true);
  });

  it('limits the images kept in the prompt to what the context window allows', () => {
    const img = { id: 'a', mime: 'image/png' as const, dataBase64: 'QUJDREVGR0g=' };
    const { turns } = assemblePrompt({
      files,
      dialect: 'libyan',
      maxImages: 2,
      history: [
        { role: 'user', content: 'one', images: [img] },
        { role: 'assistant', content: 'r' },
        { role: 'user', content: 'two', images: [img, { ...img, id: 'b' }] }
      ]
    });
    expect(turns[0]!.images).toBeUndefined();
    expect(turns[2]!.images).toHaveLength(2);
  });
});

describe('loadPersonaFiles', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rico-persona-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns usable defaults when the folder is empty', async () => {
    const f = await loadPersonaFiles(dir);
    expect(f.systemPrompt).toBeUndefined();
    expect(buildSystemPrompt(f, 'libyan')).toBe(FALLBACK_SYSTEM_PROMPT);
  });

  it('reads the persona files (tolerating a BOM, broken JSON and a leftover fewshots.json)', async () => {
    await writeFile(join(dir, 'system-prompt.md'), '﻿أنت ريكو', 'utf8');
    await writeFile(join(dir, 'fewshots.json'), JSON.stringify([{ user: 'a', assistant: 'b' }]), 'utf8');
    await writeFile(join(dir, 'dialect-overrides.json'), '{ not json', 'utf8');
    const f = await loadPersonaFiles(dir);
    expect(f.systemPrompt).toBe('أنت ريكو');
    expect(f.dialectOverrides).toEqual({});
  });
});
