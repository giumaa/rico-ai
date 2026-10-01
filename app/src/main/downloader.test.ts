import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildRequestHeaders,
  ChecksumError,
  classifyError,
  DownloadCancelledError,
  downloadFile,
  HttpStatusError,
  normalizeSha256,
  parseContentRange,
  planResponse,
  SizeMismatchError
} from './downloader';

describe('buildRequestHeaders', () => {
  it('sends no Range header for a fresh download', () => {
    expect(buildRequestHeaders(0).Range).toBeUndefined();
  });
  it('asks to resume from the first missing byte and never allows compression', () => {
    const h = buildRequestHeaders(1234);
    expect(h.Range).toBe('bytes=1234-');
    expect(h['Accept-Encoding']).toBe('identity');
  });
});

describe('parseContentRange', () => {
  it('parses a satisfied range', () => {
    expect(parseContentRange('bytes 100-199/1000')).toEqual({ start: 100, end: 199, total: 1000 });
  });
  it('parses the unsatisfied form and unknown totals', () => {
    expect(parseContentRange('bytes */1000')).toEqual({ start: -1, end: -1, total: 1000 });
    expect(parseContentRange('bytes 0-9/*')).toEqual({ start: 0, end: 9, total: null });
  });
  it('rejects garbage', () => {
    expect(parseContentRange(undefined)).toBeNull();
    expect(parseContentRange('items 1-2/3')).toBeNull();
  });
});

describe('planResponse', () => {
  it('appends on a 206 that starts at our offset', () => {
    expect(planResponse(206, { 'content-range': 'bytes 500-999/1000' }, 500)).toEqual({ action: 'append', totalBytes: 1000 });
  });
  it('restarts when the server ignores Range (200)', () => {
    expect(planResponse(200, { 'content-length': '1000' }, 500)).toEqual({ action: 'restart', totalBytes: 1000 });
    expect(planResponse(200, {}, 0)).toEqual({ action: 'restart', totalBytes: null });
  });
  it('does not trust a 206 that starts somewhere else', () => {
    expect(planResponse(206, { 'content-range': 'bytes 0-999/1000' }, 500)).toEqual({ action: 'restart-after-416' });
  });
  it('accepts a 206 for a fresh download', () => {
    expect(planResponse(206, { 'content-range': 'bytes 0-999/1000' }, 0)).toEqual({ action: 'restart', totalBytes: 1000 });
  });
  it('treats 416 as complete only when the local size equals the server size', () => {
    expect(planResponse(416, { 'content-range': 'bytes */1000' }, 1000)).toEqual({ action: 'already-complete' });
    expect(planResponse(416, { 'content-range': 'bytes */1000' }, 400)).toEqual({ action: 'restart-after-416' });
    expect(planResponse(416, {}, 400)).toEqual({ action: 'restart-after-416' });
  });
  it('fails on HTTP errors', () => {
    expect(planResponse(404, {}, 0)).toEqual({ action: 'fail', status: 404 });
    expect(planResponse(503, {}, 10)).toEqual({ action: 'fail', status: 503 });
  });
});

describe('classifyError', () => {
  it('distinguishes cancel / fatal / transient / offline', () => {
    expect(classifyError(new DownloadCancelledError())).toBe('cancelled');
    expect(classifyError(new HttpStatusError(404, 'u'))).toBe('fatal');
    expect(classifyError(new HttpStatusError(503, 'u'))).toBe('transient');
    expect(classifyError(new HttpStatusError(429, 'u'))).toBe('transient');
    expect(classifyError(new ChecksumError('f'))).toBe('fatal');
    expect(classifyError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('transient');
    expect(classifyError(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe('offline');
    expect(classifyError(Object.assign(new Error('x'), { code: 'ENOSPC' }))).toBe('fatal');
  });
});

describe('normalizeSha256', () => {
  it('accepts upper case and sha256: prefixes, rejects the rest', () => {
    const hex = 'a'.repeat(64);
    expect(normalizeSha256(` SHA256:${hex.toUpperCase()} `)).toBe(hex);
    expect(normalizeSha256('zzz')).toBeUndefined();
    expect(normalizeSha256(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------
// Integration against a real local HTTP server (supports Range, redirects, flaky connections)

interface TestServer {
  url: string;
  requests: { url: string; range?: string }[];
  close(): Promise<void>;
  /** behaviour knobs */
  ignoreRange: boolean;
  dropAfterBytes?: number; // first request only
  fail503Times: number;
}

async function startServer(body: Buffer): Promise<TestServer> {
  let dropped = false;
  const srv: TestServer = {
    url: '',
    requests: [],
    ignoreRange: false,
    fail503Times: 0,
    close: async () => undefined
  };
  const server = http.createServer((req, res) => {
    srv.requests.push({ url: req.url ?? '', range: req.headers.range });
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/file.bin' }).end();
      return;
    }
    if (req.url === '/missing') {
      res.writeHead(404).end('nope');
      return;
    }
    if (srv.fail503Times > 0) {
      srv.fail503Times--;
      res.writeHead(503).end();
      return;
    }
    let start = 0;
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    if (m && !srv.ignoreRange) start = Number(m[1]);
    if (start >= body.length) {
      res.writeHead(416, { 'Content-Range': `bytes */${body.length}` }).end();
      return;
    }
    const slice = body.subarray(start);
    if (start > 0) {
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}`,
        'Content-Length': String(slice.length)
      });
    } else {
      res.writeHead(200, { 'Content-Length': String(slice.length) });
    }
    if (srv.dropAfterBytes !== undefined && !dropped) {
      dropped = true;
      res.write(slice.subarray(0, srv.dropAfterBytes));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    res.end(slice);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  srv.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  srv.close = () => new Promise<void>((r) => server.close(() => r()));
  server.closeAllConnections?.();
  return srv;
}

describe('downloadFile (local server)', () => {
  const body = randomBytes(300_000);
  const sha = createHash('sha256').update(body).digest('hex');
  let dir: string;
  let srv: TestServer;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rico-dl-'));
    srv = await startServer(body);
  });
  afterEach(async () => {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  });

  const run = (over: Partial<Parameters<typeof downloadFile>[0]> = {}, signal = new AbortController().signal) =>
    downloadFile({
      url: `${srv.url}/file.bin`,
      destPath: join(dir, 'm.gguf'),
      signal,
      onBytes: () => undefined,
      retryDelayMs: () => 0,
      http: { allowInsecureLocalhost: true },
      ...over
    });

  it('downloads a file, reports progress and verifies sha256 + size', async () => {
    const seen: number[] = [];
    await run({ sha256: sha, expectedSize: body.length, onBytes: (r) => seen.push(r) });
    expect(Buffer.compare(await readFile(join(dir, 'm.gguf')), body)).toBe(0);
    expect(seen[seen.length - 1]).toBe(body.length);
    await expect(stat(join(dir, 'm.gguf.part'))).rejects.toThrow(); // .part was renamed
  });

  it('resumes from an existing .part file with a Range request', async () => {
    await writeFile(join(dir, 'm.gguf.part'), body.subarray(0, 100_000));
    await run({ sha256: sha });
    expect(srv.requests[0]?.range).toBe('bytes=100000-');
    expect(Buffer.compare(await readFile(join(dir, 'm.gguf')), body)).toBe(0);
  });

  it('restarts cleanly when the server ignores Range', async () => {
    srv.ignoreRange = true;
    await writeFile(join(dir, 'm.gguf.part'), body.subarray(0, 100_000));
    await run({ sha256: sha });
    expect(srv.requests[0]?.range).toBe('bytes=100000-');
    expect(Buffer.compare(await readFile(join(dir, 'm.gguf')), body)).toBe(0);
  });

  it('survives a dropped connection by resuming', async () => {
    srv.dropAfterBytes = 50_000;
    await run({ sha256: sha });
    expect(srv.requests.length).toBeGreaterThanOrEqual(2);
    expect(srv.requests[1]?.range).toMatch(/^bytes=\d+-$/);
    expect(Buffer.compare(await readFile(join(dir, 'm.gguf')), body)).toBe(0);
  });

  it('retries transient 503 responses', async () => {
    srv.fail503Times = 2;
    await run({});
    expect(Buffer.compare(await readFile(join(dir, 'm.gguf')), body)).toBe(0);
    expect(srv.requests.length).toBe(3);
  });

  it('follows redirects', async () => {
    await run({ url: `${srv.url}/redirect` });
    expect(Buffer.compare(await readFile(join(dir, 'm.gguf')), body)).toBe(0);
  });

  it('fails fast on a 404 (no retries) ', async () => {
    await expect(run({ url: `${srv.url}/missing` })).rejects.toBeInstanceOf(HttpStatusError);
    expect(srv.requests.length).toBe(1);
  });

  it('rejects a checksum mismatch and removes the bad data', async () => {
    await expect(run({ sha256: 'f'.repeat(64) })).rejects.toBeInstanceOf(ChecksumError);
    await expect(stat(join(dir, 'm.gguf'))).rejects.toThrow();
    await expect(stat(join(dir, 'm.gguf.part'))).rejects.toThrow();
  });

  it('rejects an unexpected size', async () => {
    await expect(run({ expectedSize: body.length + 1 })).rejects.toBeInstanceOf(SizeMismatchError);
  });

  it('is a no-op when the verified file already exists', async () => {
    await run({ sha256: sha });
    const before = srv.requests.length;
    await run({ sha256: sha, expectedSize: body.length });
    expect(srv.requests.length).toBe(before);
  });

  it('treats a complete .part (416) as done', async () => {
    await writeFile(join(dir, 'm.gguf.part'), body);
    await run({ sha256: sha });
    expect(Buffer.compare(await readFile(join(dir, 'm.gguf')), body)).toBe(0);
  });

  it('cancels via AbortSignal and keeps the .part file for a later resume', async () => {
    const big = randomBytes(2_000_000);
    const slow = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Length': String(big.length) });
      res.write(big.subarray(0, 200_000)); // then stall
    });
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(slow.address() as AddressInfo).port}/x`;
    const ac = new AbortController();
    const p = run({ url, onBytes: (received) => received > 150_000 && ac.abort() }, ac.signal);
    await expect(p).rejects.toBeInstanceOf(DownloadCancelledError);
    slow.closeAllConnections?.();
    await new Promise<void>((r) => slow.close(() => r()));
    expect((await stat(join(dir, 'm.gguf.part'))).isFile()).toBe(true);
  });

  it('refuses plain http outside the test hook', async () => {
    await expect(run({ http: {} })).rejects.toThrow(/non-HTTPS/);
  });
});
