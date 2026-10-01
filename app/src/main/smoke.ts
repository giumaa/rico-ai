// Developer smoke test (RICO_SMOKE_TEST=1 electron .): loads the renderer, exercises window.rico without any
// model, verifies Chromium cannot reach the network, prints one JSON line and exits. Never runs in normal use.

import { app, type BrowserWindow } from 'electron';

const SCRIPT = `(async () => {
  const out = {};
  out.hasRico = typeof window.rico === 'object' && window.rico !== null;
  out.keys = out.hasRico ? Object.keys(window.rico) : [];
  out.hasNodeGlobals = typeof require !== 'undefined' || typeof process !== 'undefined';
  out.csp = (await fetch(location.href).then(r => r.headers.get('content-security-policy')).catch(() => null)) ? 'present' : 'missing';
  out.settings = await window.rico.settings.get();
  out.models = (await window.rico.models.list()).map(m => m.id + ':' + m.status);
  out.loadState = await window.rico.models.getLoadState();
  out.dataPath = await window.rico.system.getDataPath();
  out.sys = await window.rico.system.getInfo();
  out.netFetch = await fetch('https://example.com/', { mode: 'no-cors' }).then(() => 'REACHED').catch(e => 'blocked');
  out.xhrBlocked = await new Promise((res) => { const x = new XMLHttpRequest(); x.onerror = () => res('blocked'); x.onload = () => res('REACHED'); x.open('GET', 'https://example.com/'); x.send(); });
  out.chats = await window.rico.chats.list();
  return out;
})()`;

export function runSmokeTest(win: BrowserWindow): void {
  const timer = setTimeout(() => {
    console.error('SMOKE_TIMEOUT');
    app.exit(2);
  }, 90_000);
  win.webContents.once('did-fail-load', (_e, code, desc, url) => {
    console.error('SMOKE_LOAD_FAIL', code, desc, url);
    app.exit(3);
  });
  win.webContents.once('did-finish-load', async () => {
    try {
      const result = await win.webContents.executeJavaScript(SCRIPT, true);
      console.log('SMOKE_RESULT ' + JSON.stringify(result));
      clearTimeout(timer);
      app.exit(0);
    } catch (err) {
      console.error('SMOKE_FAIL', err);
      clearTimeout(timer);
      app.exit(1);
    }
  });
}
