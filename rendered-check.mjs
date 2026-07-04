// rendered-check.mjs — Run from project root: node scripts/rendered-check.mjs
// Gate [16] — Rendered parity: the audit's static gates read CSS text; this gate
// verifies what the browser actually computes. It launches headless Chrome via the
// DevTools Protocol (no npm deps — requires Node >= 22 for built-in WebSocket),
// loads each built plugin ui.html from file://, and asserts getComputedStyle values
// declared in RENDERED_ASSERTIONS (structure-contract.mjs).
//
// This catches what static analysis cannot: cascade/specificity surprises, base-class
// rules overridden by later plugin rules, var() chains resolving to the wrong value,
// and geometry that only exists at layout time.
//
// Contract shape (structure-contract.mjs):
//   export const RENDERED_ASSERTIONS = [
//     { plugin: 'impact-atlas', selector: '.statusBar', prop: 'height', expected: '56px',
//       note: 'DS statusBar 789:38384' },
//     // probe: HTML injected into <body> when the selector matches nothing
//     // (for components only created at runtime, e.g. toasts)
//     { plugin: 'impact-atlas', selector: '.toast', probe: '<div class="toast">✓</div>',
//       prop: 'height', expected: '32px', note: 'DS toast success state' },
//   ];
// prop is a camelCase computed-style key (height, paddingLeft, columnGap, minHeight…).
// expected is compared as an exact string against getComputedStyle(el)[prop].
//
// Skips gracefully (exit 0, ⏭ lines) when Chrome is not installed or assertions are empty.

import { readFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn, spawnSync } from 'child_process';
import { pathToFileURL } from 'url';

const ROOT = process.cwd();

let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

let ASSERTIONS = [];
try {
  const m = await import(join(ROOT, 'structure-contract.mjs'));
  if (Array.isArray(m.RENDERED_ASSERTIONS)) ASSERTIONS = m.RENDERED_ASSERTIONS;
} catch { /* structure-contract.mjs optional */ }

if (!ASSERTIONS.length) {
  console.log('⏭  [16] rendered parity skipped — RENDERED_ASSERTIONS empty in structure-contract.mjs');
  process.exit(0);
}

// ── Find Chrome ───────────────────────────────────────────────────────────────
function findChrome() {
  const absolute = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean);
  for (const p of absolute) if (existsSync(p)) return p;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']) {
    const r = spawnSync('which', [name], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

const CHROME = findChrome();
if (!CHROME) {
  console.log('⏭  [16] rendered parity skipped — Chrome not found (set CHROME_PATH to enable)');
  process.exit(0);
}
if (typeof WebSocket === 'undefined') {
  console.log('⏭  [16] rendered parity skipped — Node >= 22 required (built-in WebSocket)');
  process.exit(0);
}

// ── Launch headless Chrome ────────────────────────────────────────────────────
const userDataDir = mkdtempSync(join(tmpdir(), 'rendered-check-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-sandbox',
  '--disable-gpu', '--disable-extensions', `--user-data-dir=${userDataDir}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

function cleanup() {
  try { chrome.kill(); } catch { /* already dead */ }
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.on('exit', cleanup);
setTimeout(() => { console.error('❌ [16] rendered parity timed out (30s)'); process.exit(1); }, 30000).unref();

const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  chrome.stderr.on('data', d => {
    buf += d.toString();
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) resolve(m[1]);
  });
  chrome.on('exit', () => reject(new Error(`Chrome exited before DevTools was ready:\n${buf.slice(-400)}`)));
});

// ── Minimal CDP client ────────────────────────────────────────────────────────
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0;
const pending = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params = {}, sessionId) {
  return new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, m => m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

// ── Run assertions per plugin ─────────────────────────────────────────────────
const byPlugin = {};
for (const a of ASSERTIONS) (byPlugin[a.plugin] ??= []).push(a);

const PASS = [], FAIL = [];

for (const [plugin, asserts] of Object.entries(byPlugin)) {
  const uiPath = join(ROOT, `apps/${plugin}/ui.html`);
  if (!existsSync(uiPath)) {
    for (const a of asserts) FAIL.push(`${plugin}: apps/${plugin}/ui.html not found (run the build first)`);
    continue;
  }
  const { targetId } = await send('Target.createTarget', { url: pathToFileURL(uiPath).href });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);

  // Wait for the file:// navigation to commit AND finish loading. The target's
  // INITIAL blank document already reports readyState "complete", so checking
  // readyState alone races the navigation and evaluates against about:blank.
  let loaded = false;
  for (let i = 0; i < 100; i++) {
    const r = await send('Runtime.evaluate', {
      expression: 'location.protocol === "file:" && document.readyState === "complete"',
      returnByValue: true,
    }, sessionId);
    if (r.result.value === true) { loaded = true; break; }
    await new Promise(res => setTimeout(res, 50));
  }
  if (!loaded) {
    for (const a of asserts) FAIL.push(`${plugin} ${a.selector} → ${a.prop}: page did not finish loading (5s)`);
    await send('Target.closeTarget', { targetId });
    continue;
  }

  const expr = `(() => {
    const asserts = ${JSON.stringify(asserts.map(({ selector, probe, prop }) => ({ selector, probe, prop })))};
    // Probes render inside an absolutely-positioned host so the app shell's own
    // flex/grid layout (e.g. body { display:flex; height:100vh }) cannot stretch
    // or shrink them — computed values must reflect the component's own rules.
    const probeHost = document.createElement('div');
    probeHost.style.cssText = 'position:absolute;left:0;top:0;width:600px;visibility:hidden;display:block;';
    document.body.appendChild(probeHost);
    return asserts.map(a => {
      let el = document.querySelector(a.selector);
      if (!el && a.probe) {
        probeHost.insertAdjacentHTML('beforeend', a.probe);
        el = probeHost.querySelector(a.selector) ?? document.querySelector(a.selector);
      }
      return el ? getComputedStyle(el)[a.prop] : '(selector not found)';
    });
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
  const got = r.result.value ?? [];

  asserts.forEach((a, i) => {
    const label = `${plugin} ${a.selector} → ${a.prop}`;
    if (got[i] === a.expected) PASS.push(label);
    else FAIL.push(`${label}: rendered "${got[i]}" ≠ expected "${a.expected}"${a.note ? `  [${a.note}]` : ''}`);
  });

  await send('Target.closeTarget', { targetId });
}

ws.close();
cleanup();

// ── Report ────────────────────────────────────────────────────────────────────
console.log('\n─── Gate [16] — Rendered parity (headless Chrome computed styles) ───\n');
console.log(`✅ PASS  ${PASS.length}/${PASS.length + FAIL.length} rendered assertions`);
console.log(`❌ FAIL  ${FAIL.length}`);
if (FAIL.length) {
  console.log();
  for (const f of FAIL) console.log(`  ❌ ${f}`);
  console.log('\n   Fix: the CSS cascade renders something different from the DS contract —');
  console.log('   check for later rules overriding the base, wrong var() resolution, or a stale build.');
}
process.exit(FAIL.length === 0 ? 0 : 1);
