import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DownloadProgress, Settings } from '../shared/api';
import { parseCatalog, type Catalog } from './catalog';
import { ModelManager, ProgressTracker } from './modelManager';
import { DEFAULT_SETTINGS } from './storage';

describe('ProgressTracker', () => {
  it('aggregates files, estimates unknown totals and computes a moving speed', () => {
    let now = 0;
    const t = new ProgressTracker(2, [1000, undefined], 3000, () => now);
    t.update(0, 0, 1000);
    now = 1000;
    t.update(0, 500, 1000);
    expect(t.receivedBytes()).toBe(500);
    expect(t.totalBytes()).toBe(3000); // second file unknown -> catalog estimate
    expect(t.bytesPerSecond()).toBe(500);
    now = 2000;
    t.update(1, 1000, 2000);
    expect(t.totalBytes()).toBe(3000);
    expect(t.receivedBytes()).toBe(1500);
  });

  it('throttles emission to ~4/s unless forced', () => {
    let now = 1000;
    const t = new ProgressTracker(1, [10], 10, () => now);
    expect(t.shouldEmit()).toBe(true);
    now += 100;
    expect(t.shouldEmit()).toBe(false);
    now += 160;
    expect(t.shouldEmit()).toBe(true);
    expect(t.shouldEmit(true)).toBe(true);
  });
});

interface FileServer {
  url: string;
  hits: Record<string, number>;
  close(): Promise<void>;
}

async function serve(files: Record<string, Buffer | number>): Promise<FileServer> {
  const hits: Record<string, number> = {};
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]!;
    hits[path] = (hits[path] ?? 0) + 1;
    const entry = files[path];
    if (entry === undefined) return void res.writeHead(404).end();
    if (typeof entry === 'number') return void res.writeHead(entry).end();
    let start = 0;
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    if (m) start = Number(m[1]);
    if (start >= entry.length) return void res.writeHead(416, { 'Content-Range': `bytes */${entry.length}` }).end();
    const slice = entry.subarray(start);
    res.writeHead(start ? 206 : 200, {
      'Content-Length': String(slice.length),
      ...(start ? { 'Content-Range': `bytes ${start}-${entry.length - 1}/${entry.length}` } : {})
    });
    res.end(slice);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      })
  };
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const gguf = (size: number): Buffer => Buffer.concat([Buffer.from('GGUF'), randomBytes(size - 4)]);

describe('ModelManager', () => {
  let dir: string;
  let srv: FileServer;
  let events: DownloadProgress[];
  let settings: Settings;
  let catalog: Catalog;
  let picked: string | null;
  let freeDisk: number | undefined;

  const mk = (): ModelManager =>
    new ModelManager({
      modelsDir: join(dir, 'models'),
      loadCatalog: async () => catalog,
      getSettings: async () => settings,
      emitProgress: (p) => events.push(p),
      pickModelFile: async () => picked,
      lang: () => 'en',
      http: { allowInsecureLocalhost: true },
      retryDelayMs: () => 0,
      freeDiskBytes: async () => freeDisk
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rico-mm-'));
    events = [];
    settings = { ...DEFAULT_SETTINGS };
    picked = null;
    freeDisk = undefined;
  });
  afterEach(async () => {
    await srv?.close();
    await rm(dir, { recursive: true, force: true });
  });

  const body = gguf(200_000);

  it('lists catalog models as not-installed until downloaded', async () => {
    srv = await serve({});
    catalog = parseCatalog({
      models: [{ id: 'rico-lite', sizeGB: 2.5, minRamGB: 8, contextLength: 8192, files: [{ url: `${srv.url}/a.gguf` }] }]
    });
    const list = await mk().list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'rico-lite', status: 'not-installed', isActive: false, source: 'catalog' });
  });

  it('downloads, verifies, installs and reports progress through to "done"', async () => {
    srv = await serve({ '/a.gguf': body });
    catalog = parseCatalog({
      models: [
        {
          id: 'rico-lite',
          sizeGB: 0.0002,
          minRamGB: 8,
          contextLength: 4096,
          files: [{ url: `${srv.url}/a.gguf`, sha256: sha(body), sizeBytes: body.length }],
          chatTemplateHint: 'qwen'
        }
      ]
    });
    const mm = mk();
    await mm.download('rico-lite');

    const list = await mm.list();
    expect(list[0]).toMatchObject({ id: 'rico-lite', status: 'installed' });
    const last = events[events.length - 1]!;
    expect(last).toMatchObject({ modelId: 'rico-lite', status: 'done', receivedBytes: body.length, totalBytes: body.length });
    expect(events.some((e) => e.status === 'downloading')).toBe(true);
    expect(events.some((e) => e.status === 'verifying')).toBe(true);

    const target = await mm.resolveForLoad('rico-lite');
    expect(target?.modelPath).toBe(join(dir, 'models', 'rico-lite', 'a.gguf'));
    expect(target?.requestedContext).toBe(4096);
    expect(target?.chatTemplateHint).toBe('qwen');
    expect((await stat(target!.modelPath)).size).toBe(body.length);

    // Already installed: no new request
    const hits = srv.hits['/a.gguf'];
    await mm.download('rico-lite');
    expect(srv.hits['/a.gguf']).toBe(hits);
  });

  it('downloads multi-file (split) models in order and loads from the first shard', async () => {
    const s1 = gguf(120_000);
    const s2 = randomBytes(80_000);
    srv = await serve({ '/m-00001-of-00002.gguf': s1, '/m-00002-of-00002.gguf': s2 });
    catalog = parseCatalog({
      models: [
        {
          id: 'split',
          sizeGB: 0.0002,
          files: [
            { url: `${srv.url}/m-00002-of-00002.gguf`, sizeBytes: s2.length, sha256: sha(s2) },
            { url: `${srv.url}/m-00001-of-00002.gguf`, sizeBytes: s1.length, sha256: sha(s1) }
          ]
        }
      ]
    });
    const mm = mk();
    await mm.download('split');
    const target = await mm.resolveForLoad('split');
    expect(target?.modelPath.endsWith('m-00001-of-00002.gguf')).toBe(true);
    expect(events[events.length - 1]).toMatchObject({ status: 'done', receivedBytes: s1.length + s2.length });
  });

  it('uses fallbackUrl when the primary URL fails', async () => {
    srv = await serve({ '/mirror.gguf': body });
    catalog = parseCatalog({
      models: [
        {
          id: 'm',
          sizeGB: 0.0002,
          files: [{ url: `${srv.url}/primary.gguf`, fallbackUrl: `${srv.url}/mirror.gguf`, sha256: sha(body) }]
        }
      ]
    });
    const mm = mk();
    await mm.download('m');
    expect((await mm.list())[0]!.status).toBe('installed');
    expect(srv.hits['/primary.gguf']).toBe(1);
    expect(srv.hits['/mirror.gguf']).toBe(1);
  });

  it('falls back to a complete alternative file set', async () => {
    srv = await serve({ '/single.gguf': body });
    catalog = parseCatalog({
      models: [
        {
          id: 'm',
          sizeGB: 0.0002,
          files: [{ url: `${srv.url}/gone-00001-of-00002.gguf` }, { url: `${srv.url}/gone-00002-of-00002.gguf` }],
          fallbackFiles: [{ url: `${srv.url}/single.gguf`, sha256: sha(body) }]
        }
      ]
    });
    const mm = mk();
    await mm.download('m');
    const target = await mm.resolveForLoad('m');
    expect(target?.modelPath.endsWith('single.gguf')).toBe(true);
  });

  it('reports a localised error, marks the model as errored and allows a retry', async () => {
    srv = await serve({ '/a.gguf': body });
    catalog = parseCatalog({
      models: [{ id: 'm', sizeGB: 0.0002, files: [{ url: `${srv.url}/a.gguf`, sha256: 'e'.repeat(64) }] }]
    });
    const mm = mk();
    await expect(mm.download('m')).rejects.toThrow(/corrupted/i);
    expect(events[events.length - 1]).toMatchObject({ modelId: 'm', status: 'error' });
    const entry = (await mm.list())[0]!;
    expect(entry.status).toBe('error');
    expect(entry.error).toMatch(/corrupted/i);
    // retry with a good checksum succeeds
    catalog = parseCatalog({
      models: [{ id: 'm', sizeGB: 0.0002, files: [{ url: `${srv.url}/a.gguf`, sha256: sha(body) }] }]
    });
    await mm.download('m');
    expect((await mm.list())[0]!.status).toBe('installed');
  });

  it('refuses to start when there is not enough free disk space', async () => {
    srv = await serve({ '/a.gguf': body });
    catalog = parseCatalog({
      models: [{ id: 'm', sizeGB: 2.5, files: [{ url: `${srv.url}/a.gguf`, sizeBytes: body.length }] }]
    });
    freeDisk = 1024;
    await expect(mk().download('m')).rejects.toThrow(/disk space/i);
    expect(srv.hits['/a.gguf']).toBeUndefined();
  });

  it('rejects unknown models and double downloads', async () => {
    srv = await serve({ '/a.gguf': body });
    catalog = parseCatalog({ models: [{ id: 'm', sizeGB: 0.0002, files: [{ url: `${srv.url}/a.gguf` }] }] });
    const mm = mk();
    await expect(mm.download('nope')).rejects.toThrow(/unknown/i);
    await expect(mm.download('../x')).rejects.toThrow(/unknown/i);
    const first = mm.download('m');
    await expect(mm.download('m')).rejects.toThrow(/already downloading/i);
    await first;
  });

  it('cancels a running download (resolves, emits "cancelled", keeps resumable data)', async () => {
    const big = randomBytes(1_000_000);
    const slow = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Length': String(big.length) });
      res.write(big.subarray(0, 300_000)); // then stall forever
    });
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(slow.address() as AddressInfo).port}/big.gguf`;
    srv = await serve({});
    catalog = parseCatalog({ models: [{ id: 'm', sizeGB: 0.001, files: [{ url, sizeBytes: big.length }] }] });
    const mm = mk();
    const p = mm.download('m');
    // wait until bytes flow, then cancel
    for (let i = 0; i < 100 && !events.some((e) => e.status === 'downloading' && e.receivedBytes > 0); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await mm.list())[0]).toMatchObject({ status: 'downloading' });
    mm.cancelDownload('m');
    await p;
    slow.closeAllConnections?.();
    await new Promise<void>((r) => slow.close(() => r()));
    expect(events[events.length - 1]).toMatchObject({ status: 'cancelled' });
    expect((await mm.list())[0]!.status).toBe('not-installed');
    expect((await readdir(join(dir, 'models', 'm'))).some((n) => n.endsWith('.part'))).toBe(true);
  });

  it('removes an installed model', async () => {
    srv = await serve({ '/a.gguf': body });
    catalog = parseCatalog({ models: [{ id: 'm', sizeGB: 0.0002, files: [{ url: `${srv.url}/a.gguf` }] }] });
    const mm = mk();
    await mm.download('m');
    await mm.remove('m');
    expect((await mm.list())[0]!.status).toBe('not-installed');
    await expect(stat(join(dir, 'models', 'm'))).rejects.toThrow();
  });

  it('marks the active model', async () => {
    srv = await serve({ '/a.gguf': body });
    catalog = parseCatalog({ models: [{ id: 'm', sizeGB: 0.0002, files: [{ url: `${srv.url}/a.gguf` }] }] });
    const mm = mk();
    settings.activeModelId = 'm';
    expect((await mm.list())[0]!.isActive).toBe(false); // not installed yet -> cannot be active
    await mm.download('m');
    expect((await mm.list())[0]!.isActive).toBe(true);
  });

  describe('importFile', () => {
    beforeEach(async () => {
      srv = await serve({});
      catalog = parseCatalog({ models: [] });
    });

    it('returns null when the user cancels the dialog', async () => {
      picked = null;
      expect(await mk().importFile()).toBeNull();
    });

    it('copies a .gguf into the models folder and lists it as imported', async () => {
      const src = join(dir, 'My Cool Model.Q4.gguf');
      await writeFile(src, gguf(50_000));
      picked = src;
      const mm = mk();
      const entry = await mm.importFile();
      expect(entry).toMatchObject({ source: 'imported', status: 'installed' });
      expect(entry!.id).toMatch(/^imported-my-cool-model-q4/);
      expect(events[events.length - 1]).toMatchObject({ modelId: entry!.id, status: 'done', receivedBytes: 50_000 });
      const target = await mm.resolveForLoad(entry!.id);
      expect((await stat(target!.modelPath)).size).toBe(50_000);
      expect((await mm.list()).filter((e) => e.source === 'imported')).toHaveLength(1);
      // importing the same file again creates a distinct id instead of overwriting
      const again = await mm.importFile();
      expect(again!.id).not.toBe(entry!.id);
    });

    it('imports every shard of a split model when the first shard is picked', async () => {
      await writeFile(join(dir, 'big-00001-of-00002.gguf'), gguf(30_000));
      await writeFile(join(dir, 'big-00002-of-00002.gguf'), randomBytes(20_000));
      picked = join(dir, 'big-00001-of-00002.gguf');
      const mm = mk();
      const entry = await mm.importFile();
      const target = await mm.resolveForLoad(entry!.id);
      expect(target?.modelPath.endsWith('big-00001-of-00002.gguf')).toBe(true);
      expect((await readdir(join(dir, 'models', entry!.id))).filter((n) => n.endsWith('.gguf')).sort()).toEqual([
        'big-00001-of-00002.gguf',
        'big-00002-of-00002.gguf'
      ]);
    });

    it('rejects a split model with missing shards', async () => {
      await writeFile(join(dir, 'x-00001-of-00003.gguf'), gguf(10_000));
      picked = join(dir, 'x-00001-of-00003.gguf');
      await expect(mk().importFile()).rejects.toThrow(/missing/i);
    });

    it('rejects files that are not GGUF', async () => {
      await writeFile(join(dir, 'fake.gguf'), 'not a model at all');
      picked = join(dir, 'fake.gguf');
      await expect(mk().importFile()).rejects.toThrow(/valid GGUF/i);
      await writeFile(join(dir, 'x.bin'), gguf(100));
      picked = join(dir, 'x.bin');
      await expect(mk().importFile()).rejects.toThrow(/valid GGUF/i);
    });
  });
});
