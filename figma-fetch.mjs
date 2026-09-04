// figma-fetch.mjs — a fetch wrapper with a hard timeout for every Figma REST call.
//
// Node's global fetch has NO default timeout, so a single stalled or rate-limited Figma
// response would block the whole audit — and, via the pre-commit hook, the commit — forever.
// (Seen in the wild: after running the audit several times in quick succession the API throttles,
// one request hangs open, and the run never returns.) On timeout we throw a clear, catchable
// error; every caller already wraps its fetch in try/catch and falls back to the committed
// snapshot, so a slow API degrades to "refresh skipped, using cache" instead of an infinite hang.

// Default timeout in ms. Override with FIGMA_FETCH_TIMEOUT_MS (env) if a very large file
// legitimately needs longer; floored at 1s so a bad value can't disable the guard.
export const FIGMA_FETCH_TIMEOUT_MS =
  Math.max(1000, parseInt(process.env.FIGMA_FETCH_TIMEOUT_MS, 10) || 20000);

// Build a fetch wrapper. `fetchImpl` and `timeoutMs` are injectable so the timeout behaviour
// can be unit-tested without a real network. A caller-supplied `opts.signal` is respected as-is
// (no timeout is added) so explicit cancellation still works.
export function makeFigmaFetch(fetchImpl = globalThis.fetch, timeoutMs = FIGMA_FETCH_TIMEOUT_MS) {
  return async function figmaFetch(url, opts = {}) {
    try {
      return await fetchImpl(url, { ...opts, signal: opts.signal || AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError'))
        throw new Error(`Figma API did not respond within ${timeoutMs / 1000}s (rate limit or network stall)`);
      throw e;
    }
  };
}
