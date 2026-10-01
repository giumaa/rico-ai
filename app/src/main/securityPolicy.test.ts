import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  buildCsp,
  isNavigationAllowed,
  isRequestAllowed,
  isTrustedSenderUrl,
  mimeFor,
  resolveAppFile
} from './securityPolicy';

describe('buildCsp', () => {
  it('is strict in production', () => {
    const csp = buildCsp();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("connect-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/https?:/);
  });

  it('only loosens script-src and connect-src for the Vite dev server', () => {
    const csp = buildCsp({ devOrigin: 'http://localhost:5173' });
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain('ws://localhost:5173');
  });
});

describe('isRequestAllowed', () => {
  it('allows only the app origin, data: and blob: in production', () => {
    expect(isRequestAllowed('rico://app/index.html')).toBe(true);
    expect(isRequestAllowed('rico://app/assets/x.woff2')).toBe(true);
    expect(isRequestAllowed('data:image/png;base64,AAAA')).toBe(true);
    expect(isRequestAllowed('blob:rico://app/uuid')).toBe(true);
  });

  it('blocks the internet, file:, other schemes and other hosts', () => {
    for (const u of [
      'https://example.com/',
      'http://localhost:5173/',
      'ws://localhost:5173/',
      'file:///C:/Windows/win.ini',
      'rico://evil/x',
      'ftp://x/y',
      'chrome-extension://abc/x',
      'not a url'
    ]) {
      expect(isRequestAllowed(u), u).toBe(false);
    }
  });

  it('allows exactly the dev server in development', () => {
    const opts = { devOrigin: 'http://localhost:5173' };
    expect(isRequestAllowed('http://localhost:5173/src/main.tsx', opts)).toBe(true);
    expect(isRequestAllowed('ws://localhost:5173/?token=x', opts)).toBe(true);
    expect(isRequestAllowed('http://localhost:9999/', opts)).toBe(false);
    expect(isRequestAllowed('https://example.com/', opts)).toBe(false);
  });
});

describe('navigation / IPC sender checks', () => {
  it('only allows in-app navigation', () => {
    expect(isNavigationAllowed('rico://app/index.html#/chat')).toBe(true);
    expect(isNavigationAllowed('https://evil.example/')).toBe(false);
    expect(isNavigationAllowed('file:///x')).toBe(false);
    expect(isNavigationAllowed('http://localhost:5173/', { devOrigin: 'http://localhost:5173' })).toBe(true);
    expect(isNavigationAllowed('http://localhost:5173/')).toBe(false);
  });

  it('trusts only our own pages as IPC senders', () => {
    expect(isTrustedSenderUrl('rico://app/index.html')).toBe(true);
    expect(isTrustedSenderUrl('https://evil.example/')).toBe(false);
    expect(isTrustedSenderUrl(undefined)).toBe(false);
  });
});

describe('resolveAppFile', () => {
  const root = join('C:', 'app', 'out', 'renderer');

  it('maps URL paths into the renderer folder', () => {
    expect(resolveAppFile(root, '/')).toBe(join(root, 'index.html'));
    expect(resolveAppFile(root, '/assets/a%20b.js')).toBe(join(root, 'assets', 'a b.js'));
  });

  it('refuses path traversal', () => {
    expect(resolveAppFile(root, '/../../secret.txt')).toBeNull();
    expect(resolveAppFile(root, '/%2e%2e/%2e%2e/secret.txt')).toBeNull();
    expect(resolveAppFile(root, '/a/..%2f..%2f..%2fsecret')).toBeNull();
    expect(resolveAppFile(root, '/x%00.js')).toBeNull();
  });
});

describe('mimeFor', () => {
  it('knows the web types the renderer ships', () => {
    expect(mimeFor('a.woff2')).toBe('font/woff2');
    expect(mimeFor('a.js')).toContain('javascript');
    expect(mimeFor('a.unknown')).toBe('application/octet-stream');
  });
});
