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
  parseDialectOverrides,
  parseFewshots,
  selectFewshots
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

describe('parseFewshots / parseDialectOverrides', () => {
  it('keeps only well-formed pairs', () => {
    expect(
      parseFewshots([{ user: ' u ', assistant: ' a ' }, { user: 'only' }, null, 5, { user: '', assistant: 'x' }])
    ).toEqual([{ user: 'u', assistant: 'a' }]);
    expect(parseFewshots('nope')).toEqual([]);
  });

  it('reads msa/auto strings only', () => {
    expect(parseDialectOverrides({ msa: 'm', auto: 3 })).toEqual({ msa: 'm' });
    expect(parseDialectOverrides(null)).toEqual({});
  });
});

describe('selectFewshots', () => {
  const shots = Array.from({ length: 20 }, (_, i) => ({ user: `u${i}`.padEnd(100, 'x'), assistant: `a${i}`.padEnd(100, 'y') }));

  it('caps the number of examples', () => {
    expect(selectFewshots(shots, 1_000_000).length).toBe(12);
  });

  it('respects a budget derived from the context window', () => {
    // 4096 * 0.6 = 2457 chars; each pair costs 200 chars -> 12 pairs max anyway; shrink the context
    expect(selectFewshots(shots, 1000).length).toBe(3); // 600 chars
    expect(selectFewshots(shots, 100).length).toBe(0);
  });
});

describe('assemblePrompt', () => {
  const files = {
    systemPrompt: 'SYS',
    fewshots: [{ user: 'fu', assistant: 'fa' }]
  };

  it('puts few-shot turns before the visible history and ends with the user turn', () => {
    const { systemPrompt, turns } = assemblePrompt({
      files,
      dialect: 'libyan',
      history: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' }
      ]
    });
    expect(systemPrompt).toBe('SYS');
    expect(turns.map((t) => `${t.role}:${t.content}`)).toEqual([
      'user:fu',
      'assistant:fa',
      'user:q1',
      'assistant:a1',
      'user:q2'
    ]);
  });

  it('returns no turns for an empty history (nothing to answer)', () => {
    expect(assemblePrompt({ files, dialect: 'libyan', history: [] }).turns).toEqual([]);
  });

  it('applies the dialect variant', () => {
    const { systemPrompt } = assemblePrompt({ files, dialect: 'msa', history: [{ role: 'user', content: 'x' }] });
    expect(systemPrompt.startsWith('SYS\n\n')).toBe(true);
    expect(systemPrompt).toContain(DEFAULT_DIALECT_OVERRIDES.msa);
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
    expect(f.fewshots).toEqual([]);
    expect(buildSystemPrompt(f, 'libyan')).toBe(FALLBACK_SYSTEM_PROMPT);
  });

  it('reads the three persona files (tolerating a BOM and broken JSON)', async () => {
    await writeFile(join(dir, 'system-prompt.md'), '﻿أنت ريكو', 'utf8');
    await writeFile(join(dir, 'fewshots.json'), JSON.stringify([{ user: 'a', assistant: 'b' }]), 'utf8');
    await writeFile(join(dir, 'dialect-overrides.json'), '{ not json', 'utf8');
    const f = await loadPersonaFiles(dir);
    expect(f.systemPrompt).toBe('أنت ريكو');
    expect(f.fewshots).toEqual([{ user: 'a', assistant: 'b' }]);
    expect(f.dialectOverrides).toEqual({});
  });
});
