// cdp.mjs - the one shared headless-Chrome launcher + DevTools Protocol client.
//
// Every browser-backed check (Gate [16] rendered parity, the a11y check, the code capture)
// used to carry its own copy of: find Chrome, launch it headless, wait for the DevTools
// socket, a tiny JSON-RPC `send`, open a page, and poll until it has loaded. Two copies had
// already drifted (different load guards and timeouts). This module is that code once.
//
// No npm dependencies: Node >= 22's built-in WebSocket. Callers keep their own policy
// (timeouts, what "loaded" means, skip vs fail when Chrome is missing); this module only
// provides the mechanics, so adopting it changes no check's behaviour.

import { existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

// Chromium builds Playwright installs, newest first. Only consulted when a caller opts in
// (`playwright: true`), so a machine that merely has Playwright installed does not suddenly
// start running browser gates that skipped before.
export function playwrightChromium({ env = process.env, exists = existsSync, list = readdirSync } = {}) {
  const roots = [env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), '.cache', 'ms-playwright'), join(homedir(), 'Library', 'Caches', 'ms-playwright')].filter(Boolean);
  const bins = ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe'];
  for (const root of roots) {
    let dirs = [];
    try { dirs = list(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1]); } catch { continue; }
    for (const d of dirs) for (const b of bins) { const p = join(root, d, b); if (exists(p)) return p; }
  }
  return null;
}

// Find a Chrome/Chromium binary. Order: CHROME_PATH, the macOS app bundles, then binaries on
// PATH, then (opt-in) a Playwright Chromium.
export function findChrome({ env = process.env, exists = existsSync, which = whichBin, playwright = false } = {}) {
  const absolute = [
    env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean);
  for (const p of absolute) if (exists(p)) return p;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']) {
    const p = which(name);
    if (p) return p;
  }
  return playwright ? playwrightChromium({ env, exists }) : null;
}

function whichBin(name) {
  const r = spawnSync('which', [name], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

// Launch headless Chrome and resolve once its DevTools socket is listening.
// Returns { chrome, userDataDir, wsUrl, kill }. Rejects if Chrome exits first.
export async function launchChrome(chromePath, { tmpPrefix = 'parity-chrome-' } = {}) {
  const userDataDir = mkdtempSync(join(tmpdir(), tmpPrefix));
  const chrome = spawn(chromePath, [
    '--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-sandbox',
    '--disable-gpu', '--disable-extensions', `--user-data-dir=${userDataDir}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const kill = () => {
    try { chrome.kill(); } catch { /* already dead */ }
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = '';
      chrome.stderr.on('data', (d) => {
        buf += d.toString();
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) resolve(m[1]);
      });
      chrome.on('exit', () => reject(new Error(`Chrome exited before DevTools was ready:\n${buf.slice(-400)}`)));
    });
    return { chrome, userDataDir, wsUrl, kill };
  } catch (e) { kill(); throw e; }
}

// Connect to a DevTools socket. Returns { send, on, ws, close }.
// send(method, params, sessionId) resolves with the result or rejects with "<method>: <message>".
// on(method, fn) subscribes to a protocol event; fn(params, sessionId). Returns an unsubscribe.
export async function connectCDP(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let msgId = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method) for (const fn of listeners.get(m.method) ?? []) { try { fn(m.params, m.sessionId); } catch { /* listener error */ } }
  };
  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(fn);
    return () => listeners.get(method)?.delete(fn);
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const close = () => { try { ws.close(); } catch { /* already closed */ } };
  return { send, on, ws, close };
}

// Open a page in a new target and attach a flat session with the Runtime domain enabled.
export async function openPage(send, url) {
  const { targetId } = await send('Target.createTarget', { url });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  return { targetId, sessionId };
}

// Poll `expression` in the page until it evaluates to true. Returns true when it did.
// tolerateErrors: treat a failed evaluation (a page mid-navigation) as "not yet".
export async function waitForTrue(send, sessionId, expression, { attempts = 100, intervalMs = 50, tolerateErrors = false } = {}) {
  for (let i = 0; i < attempts; i++) {
    const r = tolerateErrors
      ? await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId).catch(() => ({ result: {} }))
      : await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
    if (r.result?.value === true) return true;
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return false;
}

// The load guard for a file:// page. The target's initial about:blank already reports
// readyState "complete", so readyState alone races the navigation.
export const FILE_PAGE_LOADED = 'location.protocol === "file:" && document.readyState === "complete"';
