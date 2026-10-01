import { describe, expect, it } from 'vitest';
import {
  isValidModelId,
  localFileName,
  parseCatalog,
  parseShardName,
  primaryModelFileName,
  sanitizeFileName,
  siblingShardNames
} from './catalog';

describe('parseCatalog', () => {
  it('parses the documented schema', () => {
    const c = parseCatalog({
      version: 3,
      models: [
        {
          id: 'rico-lite',
          name: { ar: 'ريكو لايت', en: 'Rico Lite' },
          description: { ar: 'وصف', en: 'desc' },
          sizeGB: 2.5,
          minRamGB: 8,
          contextLength: 8192,
          files: [{ url: 'https://x/y/a.gguf', fallbackUrl: 'https://z/a.gguf', sha256: 'ab', sizeBytes: 100 }],
          chatTemplateHint: 'qwen'
        }
      ]
    });
    expect(c.version).toBe(3);
    expect(c.models).toHaveLength(1);
    expect(c.models[0]).toMatchObject({ id: 'rico-lite', minRamGB: 8, chatTemplateHint: 'qwen' });
    expect(c.models[0]!.files[0]).toEqual({
      url: 'https://x/y/a.gguf',
      fallbackUrl: 'https://z/a.gguf',
      sha256: 'ab',
      sizeBytes: 100
    });
  });

  it('is tolerant: skips bad models, fills defaults, ignores unknown keys', () => {
    const c = parseCatalog({
      _comment: 'x',
      models: [
        { id: 'Bad Id!' },
        { id: 'ok', name: { en: 'Only English' }, files: [{ url: 'https://a/b.gguf' }, { nourl: true }, 5] },
        { id: 'ok' }
      ]
    });
    expect(c.models.map((m) => m.id)).toEqual(['ok']);
    expect(c.models[0]!.name).toEqual({ ar: 'Only English', en: 'Only English' });
    expect(c.models[0]!.contextLength).toBe(8192);
    expect(c.models[0]!.files).toHaveLength(1);
  });

  it('survives non-object input', () => {
    expect(parseCatalog(null).models).toEqual([]);
    expect(parseCatalog('x').models).toEqual([]);
  });

  it('keeps an optional complete fallback file set', () => {
    const c = parseCatalog({
      models: [{ id: 'm', files: [{ url: 'https://a/1.gguf' }], fallbackFiles: [{ url: 'https://b/2.gguf' }] }]
    });
    expect(c.models[0]!.fallbackFiles).toEqual([{ url: 'https://b/2.gguf' }]);
  });
});

describe('model ids and file names', () => {
  it('validates ids', () => {
    expect(isValidModelId('rico-lite')).toBe(true);
    expect(isValidModelId('imported-my.model_1')).toBe(true);
    for (const bad of ['', '../x', 'A', 'a b', 'x/y', '-a', 5]) expect(isValidModelId(bad)).toBe(false);
  });

  it('derives local names from URLs (keeping shard names intact)', () => {
    expect(
      localFileName({ url: 'https://github.com/o/r/releases/download/models-v1/rico-00001-of-00003.gguf' }, 0)
    ).toBe('rico-00001-of-00003.gguf');
    expect(localFileName({ url: 'https://h/a%20b.gguf?download=true' }, 0)).toBe('a b.gguf');
    expect(localFileName({ url: 'https://h/', name: 'x.gguf' }, 0)).toBe('x.gguf');
    expect(localFileName({ url: 'https://h/' }, 1)).toBe('part-00002.gguf');
  });

  it('sanitises file names', () => {
    expect(sanitizeFileName('a\\b/c.gguf')).toBe('a_b_c.gguf');
    expect(sanitizeFileName('../evil.gguf')).not.toContain('/');
    expect(sanitizeFileName('x:y?.gguf')).toBe('x_y_.gguf');
  });
});

describe('split GGUF shards', () => {
  it('parses shard names', () => {
    expect(parseShardName('model-Q4_K_M-00002-of-00004.gguf')).toEqual({
      prefix: 'model-Q4_K_M',
      index: 2,
      count: 4
    });
    expect(parseShardName('model.gguf')).toBeNull();
  });

  it('lists all siblings of a shard', () => {
    expect(siblingShardNames('m-00001-of-00003.gguf')).toEqual([
      'm-00001-of-00003.gguf',
      'm-00002-of-00003.gguf',
      'm-00003-of-00003.gguf'
    ]);
    expect(siblingShardNames('single.gguf')).toEqual(['single.gguf']);
  });

  it('picks the first shard as the load target regardless of order', () => {
    expect(primaryModelFileName(['m-00002-of-00002.gguf', 'm-00001-of-00002.gguf', 'readme.txt'])).toBe(
      'm-00001-of-00002.gguf'
    );
    expect(primaryModelFileName(['only.gguf'])).toBe('only.gguf');
    expect(primaryModelFileName(['notes.txt'])).toBeUndefined();
  });
});
