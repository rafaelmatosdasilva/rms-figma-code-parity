import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFigmaFetch } from '../figma-fetch.mjs';

// A stalled/rate-limited Figma response used to hang the whole audit (Node's fetch has no
// timeout). figmaFetch must abort after the timeout and reject with a clear, catchable error so
// each caller can fall back to the cached snapshot instead of blocking forever.
test('rejects with a clear message when the response stalls past the timeout', async () => {
  // A fetch that never resolves on its own but honours the abort signal (as a real fetch does).
  const hangingFetch = (_url, opts) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' })));
    });
  const figmaFetch = makeFigmaFetch(hangingFetch, 30); // 30ms so the test is fast
  await assert.rejects(() => figmaFetch('https://api.figma.com/x'), /did not respond within/);
});

test('passes a fast response straight through', async () => {
  const figmaFetch = makeFigmaFetch(async () => ({ ok: true, status: 200 }), 1000);
  const res = await figmaFetch('https://api.figma.com/x');
  assert.equal(res.status, 200);
});

test('does not override a caller-supplied abort signal', async () => {
  let seenSignal = null;
  const spyFetch = async (_url, opts) => { seenSignal = opts.signal; return { ok: true }; };
  const ac = new AbortController();
  const figmaFetch = makeFigmaFetch(spyFetch, 1000);
  await figmaFetch('https://api.figma.com/x', { signal: ac.signal });
  assert.equal(seenSignal, ac.signal); // the caller's own signal is respected, not replaced
});
