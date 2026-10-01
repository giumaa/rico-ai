import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseGgufBasics, readGgufBasics } from './gguf';

const T = { U32: 4, STR: 8, ARR: 9, U64: 10, F32: 6 };

function str(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(b.length));
  return Buffer.concat([len, b]);
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}
const kvStr = (k: string, v: string): Buffer => Buffer.concat([str(k), u32(T.STR), str(v)]);
const kvU32 = (k: string, v: number): Buffer => Buffer.concat([str(k), u32(T.U32), u32(v)]);
const kvStrArray = (k: string, items: string[]): Buffer =>
  Buffer.concat([str(k), u32(T.ARR), u32(T.STR), u64(items.length), ...items.map(str)]);

function header(kvs: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from('GGUF', 'latin1'), u32(3), u64(0), u64(kvs.length), ...kvs]);
}

describe('parseGgufBasics', () => {
  it('reads architecture, block count and context length', () => {
    const buf = header([
      kvStr('general.architecture', 'qwen3vl'),
      kvStr('general.name', 'Qwen3 VL'),
      kvU32('qwen3vl.block_count', 36),
      kvU32('qwen3vl.context_length', 262144)
    ]);
    expect(parseGgufBasics(buf)).toEqual({ architecture: 'qwen3vl', blockCount: 36, contextLength: 262144 });
  });

  it('skips arrays and unrelated keys on the way', () => {
    const buf = header([
      kvStr('general.architecture', 'llama'),
      kvStrArray('general.tags', ['a', 'bb', 'ccc']),
      Buffer.concat([str('general.x'), u32(T.F32), Buffer.alloc(4)]),
      kvU32('llama.block_count', 32),
      kvU32('llama.context_length', 8192)
    ]);
    expect(parseGgufBasics(buf)).toMatchObject({ architecture: 'llama', blockCount: 32, contextLength: 8192 });
  });

  it('ignores keys of another architecture (e.g. the vision tower)', () => {
    const buf = header([
      kvStr('general.architecture', 'qwen3vl'),
      kvU32('clip.block_count', 27),
      kvU32('qwen3vl.block_count', 36)
    ]);
    expect(parseGgufBasics(buf).blockCount).toBe(36);
  });

  it('returns what it has for truncated data and nothing for non-GGUF input', () => {
    const buf = header([kvStr('general.architecture', 'llama'), kvU32('llama.block_count', 32)]);
    expect(parseGgufBasics(buf.subarray(0, buf.length - 3))).toEqual({ architecture: 'llama' });
    expect(parseGgufBasics(Buffer.from('not gguf at all, just text'))).toEqual({});
    expect(parseGgufBasics(Buffer.alloc(0))).toEqual({});
  });

  it('reads from a file and tolerates missing files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rico-gguf-'));
    try {
      const file = join(dir, 'm.gguf');
      await writeFile(file, header([kvStr('general.architecture', 'gemma3'), kvU32('gemma3.block_count', 26)]));
      expect(await readGgufBasics(file)).toMatchObject({ architecture: 'gemma3', blockCount: 26 });
      expect(await readGgufBasics(join(dir, 'missing.gguf'))).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
