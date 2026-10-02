// Resumable HTTPS downloader (Node https, runs in the main process — never in the renderer).
// - follows redirects (GitHub Releases / Hugging Face redirect to a CDN)
// - resumes with HTTP Range from a `.part` file
// - optional sha256 verification, retries with backoff, cancellation via AbortSignal
// The pure decision logic (headers / response planning) is exported separately for unit tests.

import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

export const PART_SUFFIX = '.part';
export const VERIFIED_SUFFIX = '.verified';
const USER_AGENT = 'Rico-Model-Downloader';

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly url: string
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpStatusError';
  }
}

export class ChecksumError extends Error {
  constructor(file: string) {
    super(`Checksum mismatch for ${file}`);
    this.name = 'ChecksumError';
  }
}

export class DownloadCancelledError extends Error {
  constructor() {
    super('Download cancelled');
    this.name = 'DownloadCancelledError';
  }
}

export class SizeMismatchError extends Error {
  constructor(file: string, expected: number, actual: number) {
    super(`Unexpected size for ${file}: expected ${expected} bytes, got ${actual}`);
    this.name = 'SizeMismatchError';
  }
}

// ---------------------------------------------------------------------------------------------------------
// Pure helpers

export function buildRequestHeaders(existingBytes: number): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: 'application/octet-stream, */*',
    // Never let a CDN gzip a GGUF: Range offsets must refer to the raw bytes.
    'Accept-Encoding': 'identity'
  };
  if (existingBytes > 0) headers.Range = `bytes=${existingBytes}-`;
  return headers;
}

export interface ContentRange {
  start: number;
  end: number;
  /** null when the server answered `*` for the complete length. */
  total: number | null;
}

/** Parses `Content-Range: bytes 100-199/1000` (and the unsatisfied form `bytes *\/1000`, returned as start=end=-1). */
export function parseContentRange(value: string | undefined): ContentRange | null {
  if (!value) return null;
  const m = /^\s*bytes\s+(?:(\d+)-(\d+)|\*)\/(\d+|\*)\s*$/i.exec(value);
  if (!m) return null;
  const total = m[3] === '*' ? null : Number(m[3]);
  if (m[1] === undefined || m[2] === undefined) return { start: -1, end: -1, total };
  return { start: Number(m[1]), end: Number(m[2]), total };
}

export type ResponsePlan =
  /** 206 with the expected offset: append to the existing .part file. */
  | { action: 'append'; totalBytes: number | null }
  /** 200 (or a 206 that does not start where we asked): the whole body follows, truncate the .part file. */
  | { action: 'restart'; totalBytes: number | null }
  /** 416 and the .part file already has every byte. */
  | { action: 'already-complete' }
  /** 416 but our .part file does not match the server's length: discard it and start over. */
  | { action: 'restart-after-416' }
  | { action: 'fail'; status: number };

function headerNumber(headers: IncomingHttpHeaders, name: string): number | null {
  const v = headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Decides what to do with a response given how many bytes we already have on disk. */
export function planResponse(status: number, headers: IncomingHttpHeaders, existingBytes: number): ResponsePlan {
  if (status === 206) {
    const cr = parseContentRange(headers['content-range'] as string | undefined);
    if (existingBytes === 0 && (!cr || cr.start === 0)) {
      return { action: 'restart', totalBytes: cr?.total ?? null };
    }
    if (cr && cr.start === existingBytes) return { action: 'append', totalBytes: cr.total };
    // Server resumed from an unexpected offset: cannot trust it — redo from scratch.
    return { action: 'restart-after-416' };
  }
  if (status === 200) {
    return { action: 'restart', totalBytes: headerNumber(headers, 'content-length') };
  }
  if (status === 416) {
    const cr = parseContentRange(headers['content-range'] as string | undefined);
    if (existingBytes > 0 && cr?.total != null && cr.total === existingBytes) return { action: 'already-complete' };
    return { action: 'restart-after-416' };
  }
  return { action: 'fail', status };
}

const OFFLINE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH']);
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ERR_STREAM_PREMATURE_CLOSE',
  'UND_ERR_SOCKET',
  'ECONNABORTED'
]);

export type FailureKind = 'cancelled' | 'fatal' | 'transient' | 'offline';

export function classifyError(err: unknown): FailureKind {
  if (err instanceof DownloadCancelledError) return 'cancelled';
  if (err instanceof HttpStatusError) {
    if (err.status === 408 || err.status === 429 || err.status >= 500) return 'transient';
    return 'fatal';
  }
  if (err instanceof ChecksumError || err instanceof SizeMismatchError) return 'fatal';
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code) {
    if (OFFLINE_CODES.has(code)) return 'offline';
    if (TRANSIENT_CODES.has(code)) return 'transient';
    return 'fatal'; // ENOSPC, EACCES, ...
  }
  if ((err as Error | undefined)?.name === 'AbortError') return 'cancelled';
  // Plain errors with no code (e.g. "Download stalled", socket hang up) are treated as transient.
  return 'transient';
}

/**
 * True when the SOURCE itself is unusable (file removed/forbidden, or the bytes are wrong), so a mirror / alternative file set
 * is worth trying. Offline, timeouts, 5xx/429 and local disk errors are not: switching sources would only throw away progress.
 */
export function isSourceFailure(err: unknown): boolean {
  if (err instanceof ChecksumError || err instanceof SizeMismatchError) return true;
  return err instanceof HttpStatusError && (err.status === 403 || err.status === 404 || err.status === 410);
}

export function backoffDelayMs(attempt: number): number {
  return Math.min(8000, 1000 * 2 ** attempt);
}

/** Lower-cased hex sha256 normaliser ("sha256:ABC…" and whitespace tolerated). */
export function normalizeSha256(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase().replace(/^sha256[:=]/, '');
  return /^[0-9a-f]{64}$/.test(v) ? v : undefined;
}

// ---------------------------------------------------------------------------------------------------------
// HTTP

export interface HttpOptions {
  signal?: AbortSignal;
  maxRedirects?: number;
  /** Test hook: also allow plain http:// to localhost. Never enabled in the app. */
  allowInsecureLocalhost?: boolean;
  idleTimeoutMs?: number;
}

export interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  res: IncomingMessage;
  finalUrl: string;
}

function isLocalhost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

export function httpGet(url: string, headers: Record<string, string>, opts: HttpOptions = {}): Promise<HttpResult> {
  const maxRedirects = opts.maxRedirects ?? 8;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 30_000;

  return new Promise<HttpResult>((resolve, reject) => {
    const attempt = (target: string, redirectsLeft: number): void => {
      let u: URL;
      try {
        u = new URL(target);
      } catch {
        reject(new Error(`Invalid URL: ${target}`));
        return;
      }
      const secure = u.protocol === 'https:';
      if (!secure && !(opts.allowInsecureLocalhost && u.protocol === 'http:' && isLocalhost(u.hostname))) {
        reject(new Error(`Refusing non-HTTPS URL: ${u.protocol}//${u.host}`));
        return;
      }
      if (opts.signal?.aborted) {
        reject(new DownloadCancelledError());
        return;
      }
      const lib = secure ? https : http;
      const req = lib.get(u, { headers, timeout: idleTimeoutMs }, (res) => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume(); // drain
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects'));
            return;
          }
          attempt(new URL(res.headers.location, u).toString(), redirectsLeft - 1);
          return;
        }
        resolve({ status, headers: res.headers, res, finalUrl: u.toString() });
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('Download stalled'), { code: 'ETIMEDOUT' })));
      req.on('error', (err) => reject(opts.signal?.aborted ? new DownloadCancelledError() : err));
      opts.signal?.addEventListener('abort', () => req.destroy(new DownloadCancelledError()), { once: true });
    };
    attempt(url, maxRedirects);
  });
}

// ---------------------------------------------------------------------------------------------------------
// Hashing

export async function sha256OfFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash, { signal });
  return hash.digest('hex');
}

/**
 * A completed file that passed its sha256 check gets a `<file>.verified` marker (size + mtime + sha256), so a retry or a
 * resumed multi-shard download never re-hashes gigabytes that were already verified.
 */
async function isMarkedVerified(path: string, sha: string): Promise<boolean> {
  try {
    const [st, raw] = await Promise.all([fs.stat(path), fs.readFile(path + VERIFIED_SUFFIX, 'utf8')]);
    const m = JSON.parse(raw) as { size?: number; mtimeMs?: number; sha256?: string };
    return m.size === st.size && m.mtimeMs === st.mtimeMs && m.sha256 === sha;
  } catch {
    return false;
  }
}

async function markVerified(path: string, sha: string): Promise<void> {
  try {
    const st = await fs.stat(path);
    await fs.writeFile(path + VERIFIED_SUFFIX, JSON.stringify({ size: st.size, mtimeMs: st.mtimeMs, sha256: sha }));
  } catch {
    /* the marker is only an optimisation */
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await fs.stat(path)).size;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------------------------------------
// downloadFile

export interface DownloadFileOptions {
  url: string;
  /** Final location. Partial data lives in `${destPath}.part`. */
  destPath: string;
  expectedSize?: number;
  sha256?: string;
  signal: AbortSignal;
  /** Called with the cumulative bytes of THIS file (including resumed bytes) and its total when known. */
  onBytes: (received: number, total: number | null) => void;
  onVerifying?: () => void;
  maxRetries?: number;
  retryDelayMs?: (attempt: number) => number;
  http?: Pick<HttpOptions, 'allowInsecureLocalhost' | 'idleTimeoutMs'>;
}

/** Downloads one file with resume + verification. Throws on failure (the .part file is kept unless it is invalid). */
export async function downloadFile(o: DownloadFileOptions): Promise<void> {
  const part = o.destPath + PART_SUFFIX;
  const sha = normalizeSha256(o.sha256);
  // Up to this many CONSECUTIVE attempts without any new bytes; every attempt that made progress resets the counter.
  const maxRetries = o.maxRetries ?? 20;
  const delay = o.retryDelayMs ?? backoffDelayMs;

  // Already complete from an earlier run?
  const existingFinal = await fileSize(o.destPath);
  if (existingFinal > 0 && (o.expectedSize === undefined || existingFinal === o.expectedSize)) {
    if (!sha) {
      o.onBytes(existingFinal, existingFinal);
      return;
    }
    if (await isMarkedVerified(o.destPath, sha)) {
      o.onBytes(existingFinal, existingFinal);
      return;
    }
    o.onVerifying?.();
    if ((await sha256OfFile(o.destPath, o.signal)) === sha) {
      await markVerified(o.destPath, sha);
      o.onBytes(existingFinal, existingFinal);
      return;
    }
    await fs.rm(o.destPath, { force: true });
    await fs.rm(o.destPath + VERIFIED_SUFFIX, { force: true });
  }

  let attempt = 0;
  let restartedFrom416 = false;
  for (;;) {
    if (o.signal.aborted) throw new DownloadCancelledError();
    const before = await fileSize(part);
    try {
      await transfer();
      break;
    } catch (err) {
      const kind = classifyError(err);
      if (kind === 'cancelled' || o.signal.aborted) throw new DownloadCancelledError();
      if (kind === 'fatal') throw err;
      if ((await fileSize(part)) > before) attempt = 0; // progress was made: the connection is just flaky
      const limit = kind === 'offline' ? 1 : maxRetries;
      if (attempt >= limit) throw err;
      attempt++;
      await sleep(delay(attempt - 1), o.signal);
    }
  }

  // Verify, then publish atomically.
  const size = await fileSize(part);
  if (o.expectedSize !== undefined && size !== o.expectedSize) {
    await fs.rm(part, { force: true });
    throw new SizeMismatchError(o.destPath, o.expectedSize, size);
  }
  if (sha) {
    o.onVerifying?.();
    if ((await sha256OfFile(part, o.signal)) !== sha) {
      await fs.rm(part, { force: true });
      throw new ChecksumError(o.destPath);
    }
  }
  await fs.rename(part, o.destPath);
  if (sha) await markVerified(o.destPath, sha);
  o.onBytes(size, size);

  async function transfer(): Promise<void> {
    let existing = await fileSize(part);
    if (o.expectedSize !== undefined && existing > o.expectedSize) {
      await fs.rm(part, { force: true });
      existing = 0;
    }
    if (o.expectedSize !== undefined && existing === o.expectedSize) {
      o.onBytes(existing, o.expectedSize);
      return; // all bytes are already on disk; verification happens after the loop
    }

    // First progress event of a resumed download = what is already on disk (the bar never dips to 0 while connecting).
    if (existing > 0) o.onBytes(existing, o.expectedSize ?? null);
    const result = await httpGet(o.url, buildRequestHeaders(existing), { signal: o.signal, ...o.http });
    const plan = planResponse(result.status, result.headers, existing);

    if (plan.action === 'fail') {
      result.res.resume();
      throw new HttpStatusError(plan.status, o.url);
    }
    if (plan.action === 'already-complete') {
      result.res.resume();
      return;
    }
    if (plan.action === 'restart-after-416') {
      result.res.resume();
      await fs.rm(part, { force: true });
      if (restartedFrom416) throw new HttpStatusError(result.status, o.url);
      restartedFrom416 = true;
      return transfer();
    }

    const append = plan.action === 'append';
    let received = append ? existing : 0;
    const total = plan.totalBytes ?? o.expectedSize ?? null;
    if (o.expectedSize !== undefined && plan.totalBytes !== null && plan.totalBytes !== o.expectedSize) {
      result.res.resume();
      throw new SizeMismatchError(o.url, o.expectedSize, plan.totalBytes);
    }
    o.onBytes(received, total);

    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        o.onBytes(received, total);
        cb(null, chunk);
      }
    });
    await pipeline(result.res, counter, createWriteStream(part, { flags: append ? 'a' : 'w' }), {
      signal: o.signal
    });
    // A server closing early without error would otherwise look like success.
    if (total !== null && received < total) {
      throw Object.assign(new Error('Connection closed before the download finished'), {
        code: 'ERR_STREAM_PREMATURE_CLOSE'
      });
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DownloadCancelledError());
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new DownloadCancelledError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
