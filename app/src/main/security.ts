// Electron wiring for the privacy guarantees: no network from Chromium, no navigation, no popups, no telemetry.
// (Model downloads happen in this process through Node's https — see downloader.ts — never through Chromium.)

import { app, protocol, type Session, type WebContents } from 'electron';
import { promises as fs } from 'node:fs';
import {
  APP_HOST,
  APP_SCHEME,
  buildCsp,
  isNavigationAllowed,
  isRequestAllowed,
  mimeFor,
  resolveAppFile,
  type PolicyOptions
} from './securityPolicy';

/** Must run before app 'ready'. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ]);
}

/** Must run before app 'ready': switches that stop Chromium from talking to the network on its own. */
export function applyPrivacySwitches(opts: PolicyOptions): void {
  const sw = app.commandLine;
  sw.appendSwitch('disable-background-networking');
  sw.appendSwitch('disable-component-update');
  sw.appendSwitch('disable-domain-reliability');
  sw.appendSwitch('disable-sync');
  sw.appendSwitch('disable-breakpad');
  sw.appendSwitch('disable-client-side-phishing-detection');
  sw.appendSwitch('disable-default-apps');
  sw.appendSwitch('no-pings');
  sw.appendSwitch('no-proxy-server'); // no WPAD / PAC lookups
  sw.appendSwitch('disable-features', 'Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,CertificateTransparencyComponentUpdater');
  // Belt and braces: Chromium cannot resolve any host (the dev server on localhost excepted).
  const exclude = opts.devOrigin ? ', EXCLUDE localhost, EXCLUDE 127.0.0.1' : '';
  sw.appendSwitch('host-resolver-rules', `MAP * ~NOTFOUND${exclude}`);
}

/** Serves the built renderer from rico://app/ with a strict CSP header. Call after 'ready'. */
export function installRendererProtocol(rendererRoot: string): void {
  const csp = buildCsp();
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    const forbidden = (status: number): Response => new Response('Forbidden', { status });
    if (url.host !== APP_HOST) return forbidden(403);
    const file = resolveAppFile(rendererRoot, url.pathname);
    if (!file) return forbidden(403);
    try {
      const data = await fs.readFile(file);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          'Content-Type': mimeFor(file),
          'Content-Security-Policy': csp,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store'
        }
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

/** Locks a Session: cancels every non-app request, denies all permissions, adds CSP in dev. */
export function lockDownSession(ses: Session, opts: PolicyOptions): void {
  const blocked: string[] = [];
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isRequestAllowed(details.url, opts);
    if (!allowed) {
      blocked.push(details.url);
      if (blocked.length <= 20) console.warn('[privacy] blocked request:', details.url.slice(0, 200));
    }
    callback({ cancel: !allowed });
  });

  if (opts.devOrigin) {
    const csp = buildCsp(opts);
    ses.webRequest.onHeadersReceived((details, callback) => {
      if (isNavigationAllowed(details.url, opts)) {
        callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
      } else {
        callback({});
      }
    });
  }

  // Only the clipboard write used by "copy" buttons is allowed; everything else is denied.
  const allowedPermissions = new Set(['clipboard-sanitized-write']);
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowedPermissions.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowedPermissions.has(permission));
  ses.setDevicePermissionHandler(() => false);
  ses.setSpellCheckerEnabled(false); // the spell checker downloads dictionaries from Google otherwise
  ses.setProxy({ mode: 'direct' }).catch(() => undefined);
}

/** Per-WebContents hardening: no popups, no webviews, no navigation away from the app. */
export function hardenWebContents(contents: WebContents, opts: PolicyOptions): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (!isNavigationAllowed(url, opts)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!isNavigationAllowed(url, opts)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}
