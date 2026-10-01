import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DownloadProgress, Settings } from '../shared/api';
import { findSiblingMmproj, isMmprojName, mmprojFileName, parseCatalog, type Catalog } from './catalog';
import { ModelManager } from './modelManager';
import { DEFAULT_SETTINGS } from './storage';

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const gguf = (size: number): Buffer => Buffer.concat([Buffer.from('GGUF'), randomBytes(size - 4)]);

async function serve(files: Record<string, Buffer>): Promise<{ url: string; hits: Record<string, number>; close(): Promise<void> }> {
  const hits: Record<string, number> = {};
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]!;
    hits[path] = (hits[path] ?? 0) + 1;
    const body = files[path];
    if (!body) return void res.writeHead(404).end();
    let start = 0;
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    if (m) start = Number(m[1]);
    if (start >= body.length) return void res.writeHead(416, { 'Content-Range': `bytes */${body.length}` }).end();
    const slice = body.subarray(start);
    res.writeHead(start ? 206 : 200, { 'Content-Length': String(slice.length), ...(start ? { 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}` } : {}) });
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

describe('catalog: mmproj helpers', () => {
  it('parses the optional mmproj file', () => {
    const c = parseCatalog({
      models: [{ id: 'v', files: [{ url: 'https://h/model.gguf' }], mmproj: { url: 'https://h/mmproj-model-f16.gguf', fallbackUrl: 'https://m/x.gguf', sha256: 'ab', sizeBytes: 5 } }, { id: 't', files: [{ url: 'https://h/t.gguf' }] }]
    });
    expect(c.models[0]!.mmproj).toEqual({ url: 'https://h/mmproj-model-f16.gguf', fallbackUrl: 'https://m/x.gguf', sha256: 'ab', sizeBytes: 5 });
    expect(c.models[1]!.mmproj).toBeUndefined();
  });

  it('never lets the projector name collide with a model file', () => {
    expect(mmprojFileName({ url: 'https://h/mm.gguf' }, ['model.gguf'])).toBe('mm.gguf');
    expect(mmprojFileName({ url: 'https://h/model.gguf' }, ['model.gguf'])).toBe('mmproj-model.gguf');
  });

  it('matches a projector to its model by base name, ignoring quantisation', () => {
    const files = ['Qwen3-VL-4B-Instruct-Q4_K_M.gguf', 'mmproj-Qwen3-VL-4B-Instruct-F16.gguf', 'mmproj-Other-Model-F16.gguf', 'notes.txt'];
    expect(findSiblingMmproj('Qwen3-VL-4B-Instruct-Q4_K_M.gguf', files)).toBe('mmproj-Qwen3-VL-4B-Instruct-F16.gguf');
    expect(findSiblingMmproj('Qwen3-VL-4B-Instruct-Q8_0.gguf', files)).toBe('mmproj-Qwen3-VL-4B-Instruct-F16.gguf');
    expect(findSiblingMmproj('Unrelated-7B-Q4_K_M.gguf', files)).toBeUndefined();
    // ambiguous: two projectors for the same base -> do not guess
    expect(findSiblingMmproj('Gemma-Q4_K_M.gguf', ['mmproj-Gemma-F16.gguf', 'Gemma-mmproj-BF16.gguf'])).toBeUndefined();
    expect(findSiblingMmproj('big-00001-of-00002.gguf', ['mmproj-big-f16.gguf'])).toBe('mmproj-big-f16.gguf');
    expect(isMmprojName('mmproj-x.gguf')).toBe(true);
    expect(isMmprojName('model.gguf')).toBe(false);
  });
});

describe('ModelManager with vision models', () => {
  let dir: string;
  let srv: Awaited<ReturnType<typeof serve>>;
  let events: DownloadProgress[];
  let settings: Settings;
  let catalog: Catalog;
  let picked: string | null;

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
      freeDiskBytes: async () => undefined
    });

  const model = gguf(150_000);
  const mmproj = gguf(60_000);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rico-vis-'));
    events = [];
    settings = { ...DEFAULT_SETTINGS };
    picked = null;
    srv = await serve({ '/model.gguf': model, '/mmproj-model-f16.gguf': mmproj, '/old.gguf': gguf(40_000) });
  });
  afterEach(async () => {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  });

  const visionCatalog = (): Catalog =>
    parseCatalog({
      models: [
        {
          id: 'rico-lite',
          sizeGB: 0.0002,
          files: [{ url: `${srv.url}/model.gguf`, sizeBytes: model.length, sha256: sha(model) }],
          mmproj: { url: `${srv.url}/mmproj-model-f16.gguf`, sizeBytes: mmproj.length, sha256: sha(mmproj) }
        }
      ]
    });

  it('flags catalog vision models before download and downloads the projector alongside the model', async () => {
    catalog = visionCatalog();
    const mm = mk();
    expect((await mm.list())[0]).toMatchObject({ status: 'not-installed', supportsVision: true });

    await mm.download('rico-lite');
    expect((await mm.list())[0]).toMatchObject({ status: 'installed', supportsVision: true });
    expect(events[events.length - 1]).toMatchObject({ status: 'done', receivedBytes: model.length + mmproj.length, totalBytes: model.length + mmproj.length });

    const target = await mm.resolveForLoad('rico-lite');
    expect(target?.modelPath).toBe(join(dir, 'models', 'rico-lite', 'model.gguf'));
    expect(target?.mmprojPath).toBe(join(dir, 'models', 'rico-lite', 'mmproj-model-f16.gguf'));
    expect(target!.sizeGB).toBeCloseTo(model.length / 1024 ** 3, 9); // model only, the projector is not counted
  });

  it('text-only catalog entries stay text-only', async () => {
    catalog = parseCatalog({ models: [{ id: 't', sizeGB: 0.0002, files: [{ url: `${srv.url}/model.gguf` }] }] });
    const mm = mk();
    await mm.download('t');
    expect((await mm.list())[0]).toMatchObject({ status: 'installed', supportsVision: false });
    expect((await mm.resolveForLoad('t'))?.mmprojPath).toBeUndefined();
  });

  it('treats an install of an OLDER catalog version as not installed and cleans it up after the upgrade', async () => {
    // v1: text model
    catalog = parseCatalog({ models: [{ id: 'rico-lite', sizeGB: 0.0002, files: [{ url: `${srv.url}/old.gguf` }] }] });
    const mm = mk();
    await mm.download('rico-lite');
    expect((await mm.list())[0]!.status).toBe('installed');

    // v2: vision model replaces it under the same id
    catalog = visionCatalog();
    expect((await mm.list())[0]).toMatchObject({ status: 'not-installed', supportsVision: true });
    expect(await mm.isInstalled('rico-lite')).toBe(false);
    expect(await mm.resolveForLoad('rico-lite')).toBeNull();

    await mm.download('rico-lite');
    expect((await mm.list())[0]!.status).toBe('installed');
    expect((await readdir(join(dir, 'models', 'rico-lite'))).sort()).toEqual(['manifest.json', 'mmproj-model-f16.gguf', 'model.gguf']);
  });

  it('the projector has its own fallback URL', async () => {
    catalog = parseCatalog({
      models: [
        {
          id: 'v',
          sizeGB: 0.0002,
          files: [{ url: `${srv.url}/model.gguf` }],
          mmproj: { url: `${srv.url}/nope.gguf`, fallbackUrl: `${srv.url}/mmproj-model-f16.gguf`, sha256: sha(mmproj) }
        }
      ]
    });
    const mm = mk();
    await mm.download('v');
    // the local name always comes from the primary URL; only the bytes come from the fallback
    expect((await mm.resolveForLoad('v'))?.mmprojPath?.endsWith('nope.gguf')).toBe(true);
    expect(srv.hits['/nope.gguf']).toBe(1);
  });

  describe('import', () => {
    beforeEach(() => {
      catalog = parseCatalog({ models: [] });
    });

    it('imports a sibling projector with the model and marks it vision-capable', async () => {
      await writeFile(join(dir, 'Cool-VL-4B-Q4_K_M.gguf'), gguf(30_000));
      await writeFile(join(dir, 'mmproj-Cool-VL-4B-F16.gguf'), gguf(10_000));
      await writeFile(join(dir, 'mmproj-Another-F16.gguf'), gguf(10_000));
      picked = join(dir, 'Cool-VL-4B-Q4_K_M.gguf');
      const mm = mk();
      const entry = await mm.importFile();
      expect(entry).toMatchObject({ source: 'imported', supportsVision: true });
      const target = await mm.resolveForLoad(entry!.id);
      expect(target?.modelPath.endsWith('Cool-VL-4B-Q4_K_M.gguf')).toBe(true);
      expect(target?.mmprojPath?.endsWith('mmproj-Cool-VL-4B-F16.gguf')).toBe(true);
      expect(events[events.length - 1]).toMatchObject({ status: 'done', receivedBytes: 40_000 });
    });

    it('imports plain models as text-only and refuses a projector picked as the model', async () => {
      await writeFile(join(dir, 'plain.gguf'), gguf(10_000));
      picked = join(dir, 'plain.gguf');
      const mm = mk();
      expect(await mm.importFile()).toMatchObject({ supportsVision: false });

      await writeFile(join(dir, 'mmproj-x-f16.gguf'), gguf(10_000));
      picked = join(dir, 'mmproj-x-f16.gguf');
      await expect(mm.importFile()).rejects.toThrow(/projector/i);
    });
  });
});
