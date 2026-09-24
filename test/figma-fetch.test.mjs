import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFigmaFetch } from '../figma-fetch.mjs';

// A stalled/rate-limited Figma response used to hang the whole audit (Node's fetch has no
// timeout). figmaFetch must abort after the timeout and reject with a clear, catchable error so
// each caller can fall back to the cached snapshot instead of blocking forever.
test('rejects with a clear message when the response stalls past the timeout', async () => {
  // A fetch that never resolves on its own but honours the abort signal (as a real fetch does).
  // AbortSignal.timeout() uses an unref'd timer, and a mock holds no socket, so keep the
  // event loop alive until the abort lands (a real stalled fetch holds its socket open).
  const hangingFetch = (_url, opts) =>
    new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => {}, 10_000);
      opts.signal.addEventListener('abort', () => {
        clearTimeout(keepAlive);
        reject(Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }));
      });
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

// ── Rate-limit resilience: a 429 must not drop the refresh to stale cache; the
// wrapper waits out the throttle and returns the live response (full depth kept).
const headers = (h) => ({ get: (k) => h[k.toLowerCase()] ?? null });

test('retries a 429 and returns the eventual success (no data dropped)', async () => {
  let calls = 0; const slept = [];
  const fetchImpl = async () => (++calls < 3 ? { status: 429, headers: headers({}) } : { ok: true, status: 200 });
  const figmaFetch = makeFigmaFetch(fetchImpl, 1000, { sleep: async (ms) => { slept.push(ms); } });
  const res = await figmaFetch('https://api.figma.com/x');
  assert.equal(res.status, 200);
  assert.equal(calls, 3);            // two 429s then a 200
  assert.equal(slept.length, 2);     // backed off before each retry
});

test('honours the Retry-After header', async () => {
  let calls = 0; const slept = [];
  const fetchImpl = async () => (++calls === 1 ? { status: 429, headers: headers({ 'retry-after': '2' }) } : { ok: true, status: 200 });
  const figmaFetch = makeFigmaFetch(fetchImpl, 1000, { sleep: async (ms) => { slept.push(ms); } });
  await figmaFetch('https://api.figma.com/x');
  assert.deepEqual(slept, [2000]);   // waited exactly the server-requested 2s
});

test('gives up after maxRetries and returns the last 429 (caller then uses cache)', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { status: 429, headers: headers({}) }; };
  const figmaFetch = makeFigmaFetch(fetchImpl, 1000, { maxRetries: 2, sleep: async () => {} });
  const res = await figmaFetch('https://api.figma.com/x');
  assert.equal(res.status, 429);
  assert.equal(calls, 3);            // initial + 2 retries
});

test('does not retry under a caller-supplied signal', async () => {
  let calls = 0; let slept = 0;
  const fetchImpl = async () => { calls++; return { status: 429, headers: headers({}) }; };
  const ac = new AbortController();
  const figmaFetch = makeFigmaFetch(fetchImpl, 1000, { sleep: async () => { slept++; } });
  const res = await figmaFetch('https://api.figma.com/x', { signal: ac.signal });
  assert.equal(res.status, 429);
  assert.equal(calls, 1);
  assert.equal(slept, 0);
});

test('a non-retryable status (403) returns immediately', async () => {
  let calls = 0;
  const figmaFetch = makeFigmaFetch(async () => { calls++; return { status: 403, headers: headers({}) }; }, 1000, { sleep: async () => {} });
  const res = await figmaFetch('https://api.figma.com/x');
  assert.equal(res.status, 403);
  assert.equal(calls, 1);
});

test('clamps a large Retry-After to the backoff cap (bounded wait invariant)', async () => {
  let calls = 0; const slept = [];
  const fetchImpl = async () => (++calls === 1 ? { status: 429, headers: headers({ 'retry-after': '3600' }) } : { ok: true, status: 200 });
  const figmaFetch = makeFigmaFetch(fetchImpl, 1000, { backoffCapMs: 5000, sleep: async (ms) => { slept.push(ms); } });
  await figmaFetch('https://api.figma.com/x');
  assert.deepEqual(slept, [5000]);   // 3600s requested, clamped to the 5s cap
});
