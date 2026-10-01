// Minimal GGUF header reader: just the numbers Rico needs (architecture, block count, training context).
// Works on the first bytes of the file only, so it is instant even for 20 GB models. Pure parsing + a tiny fs helper.

import { promises as fs } from 'node:fs';

export interface GgufBasics {
  architecture?: string;
  blockCount?: number;
  contextLength?: number;
}

const T = { U8: 0, I8: 1, U16: 2, I16: 3, U32: 4, I32: 5, F32: 6, BOOL: 7, STR: 8, ARR: 9, U64: 10, I64: 11, F64: 12 } as const;
const SCALAR_SIZE: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

class OutOfData extends Error {}

class Reader {
  pos = 0;
  constructor(readonly b: Buffer) {}
  need(n: number): void {
    if (this.pos + n > this.b.length) throw new OutOfData();
  }
  u32(): number {
    this.need(4);
    const v = this.b.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  u64(): number {
    this.need(8);
    const v = Number(this.b.readBigUInt64LE(this.pos));
    this.pos += 8;
    return v;
  }
  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }
  str(): string {
    const len = this.u64();
    if (len > 1 << 24) throw new Error('implausible string length');
    this.need(len);
    const s = this.b.toString('utf8', this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
}

function readScalar(r: Reader, type: number): number | undefined {
  switch (type) {
    case T.U8:
    case T.BOOL:
      r.need(1);
      return r.b[r.pos++];
    case T.I8:
      r.need(1);
      return r.b.readInt8(r.pos++);
    case T.U16: {
      r.need(2);
      const v = r.b.readUInt16LE(r.pos);
      r.pos += 2;
      return v;
    }
    case T.I16: {
      r.need(2);
      const v = r.b.readInt16LE(r.pos);
      r.pos += 2;
      return v;
    }
    case T.U32:
      return r.u32();
    case T.I32: {
      r.need(4);
      const v = r.b.readInt32LE(r.pos);
      r.pos += 4;
      return v;
    }
    case T.U64:
    case T.I64:
      return r.u64();
    default:
      r.skip(SCALAR_SIZE[type] ?? 0);
      return undefined;
  }
}

function skipValue(r: Reader, type: number): void {
  if (type === T.STR) {
    r.str();
  } else if (type === T.ARR) {
    const elType = r.u32();
    const count = r.u64();
    if (elType === T.STR) for (let i = 0; i < count; i++) r.str();
    else if (SCALAR_SIZE[elType] !== undefined) r.skip(SCALAR_SIZE[elType]! * count);
    else throw new Error('unsupported array element type');
  } else if (SCALAR_SIZE[type] !== undefined) {
    r.skip(SCALAR_SIZE[type]!);
  } else {
    throw new Error('unsupported value type');
  }
}

/** Parses the metadata section of a GGUF header held in `buf`. Never throws: returns what it found. */
export function parseGgufBasics(buf: Buffer): GgufBasics {
  const out: GgufBasics = {};
  try {
    const r = new Reader(buf);
    if (buf.length < 24 || buf.toString('latin1', 0, 4) !== 'GGUF') return out;
    r.pos = 4;
    const version = r.u32();
    if (version < 2 || version > 3) return out;
    r.u64(); // tensor count
    const kvCount = r.u64();
    for (let i = 0; i < kvCount; i++) {
      const key = r.str();
      const type = r.u32();
      if (key === 'general.architecture' && type === T.STR) {
        out.architecture = r.str();
      } else if (/\.(block_count|context_length)$/.test(key) && SCALAR_SIZE[type] !== undefined && type !== T.ARR) {
        const v = readScalar(r, type);
        const arch = out.architecture;
        const matches = !arch || key.startsWith(`${arch}.`);
        if (v !== undefined && matches) {
          if (key.endsWith('.block_count') && out.blockCount === undefined) out.blockCount = v;
          if (key.endsWith('.context_length') && out.contextLength === undefined) out.contextLength = v;
        }
      } else {
        skipValue(r, type);
      }
      if (out.blockCount !== undefined && out.contextLength !== undefined && out.architecture !== undefined) break;
    }
  } catch {
    /* truncated or unsupported: return what we have */
  }
  return out;
}

/** Reads the head of a .gguf file (first 4 MiB covers the metadata of every real model). */
export async function readGgufBasics(path: string): Promise<GgufBasics> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(path, 'r');
    const buf = Buffer.alloc(4 * 1024 * 1024);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return parseGgufBasics(buf.subarray(0, bytesRead));
  } catch {
    return {};
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
