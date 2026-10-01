// Pure security policy helpers (no Electron imports): CSP, request/navigation allow-lists, static file resolving.

import { extname, join, normalize, sep } from 'node:path';

export const APP_SCHEME = 'rico';
export const APP_HOST = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

export interface PolicyOptions {
  /** Vite dev server origin (e.g. http://localhost:5173) — only set in development. */
  devOrigin?: string;
}

/**
 * Strict Content-Security-Policy sent with every renderer document. Nothing in the renderer needs the network:
 * all talking to the outside world happens in the main process.
 */
export function buildCsp(opts: PolicyOptions = {}): string {
  const dev = !!opts.devOrigin;
  const wsOrigin = opts.devOrigin ? opts.devOrigin.replace(/^http/, 'ws') : '';
  const scriptSrc = dev ? "'self' 'unsafe-inline'" : "'self'"; // dev: Vite's React-refresh preamble is inline
  const connectSrc = dev ? `'self' ${wsOrigin}` : "'self'";
  return [
    "default-src 'none'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'", // React inline style attributes + highlight.js
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'"
  ].join('; ');
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.origin && u.origin !== 'null') return u.origin;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** Allow-list for Chromium network requests (session.webRequest). Everything else is cancelled. */
export function isRequestAllowed(url: string, opts: PolicyOptions = {}): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === `${APP_SCHEME}:` && u.host === APP_HOST) return true;
  if (u.protocol === 'data:' || u.protocol === 'blob:') return true;
  if (opts.devOrigin) {
    if (u.protocol === 'devtools:' || u.protocol === 'chrome-devtools:') return true;
    const dev = new URL(opts.devOrigin);
    if ((u.protocol === 'http:' || u.protocol === 'ws:') && u.host === dev.host) return true;
  }
  return false;
}

/** In-window navigations are only allowed within the app's own origin. */
export function isNavigationAllowed(url: string, opts: PolicyOptions = {}): boolean {
  const origin = originOf(url);
  if (!origin) return false;
  if (origin === APP_ORIGIN) return true;
  if (opts.devOrigin && origin === originOf(opts.devOrigin)) return true;
  return false;
}

/** IPC senders must be one of our own pages. */
export function isTrustedSenderUrl(url: string | undefined, opts: PolicyOptions = {}): boolean {
  return !!url && isNavigationAllowed(url, opts);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm'
};

export function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** Maps a rico://app/<pathname> URL path to a file under `rootDir`, refusing path traversal. */
export function resolveAppFile(rootDir: string, urlPathname: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPathname);
  } catch {
    return null;
  }
  if (rel.includes('\0')) return null;
  if (rel === '' || rel === '/') rel = '/index.html';
  const root = normalize(rootDir);
  const abs = normalize(join(root, rel));
  if (abs !== root && !abs.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
  return abs;
}
