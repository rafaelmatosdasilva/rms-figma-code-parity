// cdp.mjs — the shared headless-Chrome plumbing. Pins the browser lookup order (so adopting the
// module changes no gate's behaviour) and, when a browser is available, that a page opens, loads
// and evaluates end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { findChrome, playwrightChromium, launchChrome, connectCDP, openPage, waitForTrue, FILE_PAGE_LOADED } from '../cdp.mjs';

const none = () => null;

test('findChrome: CHROME_PATH wins, then PATH binaries; Playwright only when opted in', () => {
  const exists = (p) => p === '/x/chrome' || p === '/pw/chromium-1200/chrome-linux/chrome';
  assert.equal(findChrome({ env: { CHROME_PATH: '/x/chrome' }, exists, which: none }), '/x/chrome');
  assert.equal(findChrome({ env: {}, exists: () => false, which: (n) => (n === 'chromium' ? '/usr/bin/chromium' : null) }), '/usr/bin/chromium');
  // A Playwright install is ignored by default, so no gate starts running where it skipped before.
  const env = { PLAYWRIGHT_BROWSERS_PATH: '/pw' };
  assert.equal(findChrome({ env, exists, which: none }), null);
});

test('playwrightChromium: picks the newest chromium-N build that has a binary', () => {
  const list = () => ['chromium-1100', 'chromium_headless_shell-1200', 'chromium-1200', 'ffmpeg-1'];
  const exists = (p) => p.endsWith('chrome-linux/chrome');
  assert.equal(playwrightChromium({ env: { PLAYWRIGHT_BROWSERS_PATH: '/pw' }, exists, list }), '/pw/chromium-1200/chrome-linux/chrome');
  assert.equal(playwrightChromium({ env: {}, exists: () => false, list: () => { throw new Error('none'); } }), null);
});

const CHROME = findChrome({ playwright: true });
test('launch, open a file:// page, wait for load and evaluate', { skip: !CHROME || typeof WebSocket === 'undefined' ? 'no Chrome available' : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-test-'));
  const page = join(dir, 'p.html');
  writeFileSync(page, '<!doctype html><style>:root{--gap-s:8px}</style><div id="x" style="padding:var(--gap-s)"></div>');
  const browser = await launchChrome(CHROME, { tmpPrefix: 'cdp-test-' });
  try {
    const { send, close } = await connectCDP(browser.wsUrl);
    const { targetId, sessionId } = await openPage(send, pathToFileURL(page).href);
    assert.equal(await waitForTrue(send, sessionId, FILE_PAGE_LOADED), true);
    const r = await send('Runtime.evaluate', { expression: 'getComputedStyle(document.getElementById("x")).paddingTop', returnByValue: true }, sessionId);
    assert.equal(r.result.value, '8px');
    await assert.rejects(() => send('No.suchMethod'), /No\.suchMethod/);
    await send('Target.closeTarget', { targetId });
    close();
  } finally { browser.kill(); }
});
