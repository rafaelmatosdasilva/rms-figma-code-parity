// figma-fetch.mjs - a fetch wrapper with a hard timeout AND throttle-aware retries
// for every Figma REST call.
//
// Node's global fetch has NO default timeout, so a single stalled response would block
// the whole audit - and, via the pre-commit hook, the commit - forever. On timeout we
// throw a clear, catchable error; every caller wraps its fetch in try/catch and falls
// back to the committed snapshot, so a slow API degrades to "refresh skipped, using
// cache" instead of an infinite hang.
//
// Rate limiting: Phase-1 fires several refreshers (bound tokens, state tokens, state
// bindings, frame geometry, …), each walking the DS frames, so the /nodes endpoint gets
// hit hard and Figma answers 429. Previously that 429 propagated as a failed refresh and
// the run fell back to STALE snapshots - losing depth. Now a 429 (or a transient 503) is
// retried with backoff, honouring the Retry-After header, so the refresh WAITS out the
// throttle and completes with the full, live data. Waiting is bounded (finite attempts,
// each wait capped) so it can never hang like the pre-timeout days. Only Phase-1 refreshes
// touch the network, so these waits never affect the cache-only pre-commit audit.

// Per-attempt timeout in ms. Override with FIGMA_FETCH_TIMEOUT_MS; floored at 1s.
export const FIGMA_FETCH_TIMEOUT_MS =
  Math.max(1000, parseInt(process.env.FIGMA_FETCH_TIMEOUT_MS, 10) || 20000);

// Max retries on a throttle/transient status. FIGMA_FETCH_MAX_RETRIES=0 disables retrying.
const _envRetries = parseInt(process.env.FIGMA_FETCH_MAX_RETRIES, 10);
export const FIGMA_FETCH_MAX_RETRIES = Number.isFinite(_envRetries) && _envRetries >= 0 ? _envRetries : 4;

// Upper bound on any single backoff wait (also caps a large Retry-After).
const FIGMA_FETCH_BACKOFF_CAP_MS =
  Math.max(1000, parseInt(process.env.FIGMA_FETCH_BACKOFF_CAP_MS, 10) || 10000);

// Statuses worth retrying: 429 Too Many Requests, 503 Service Unavailable (transient).
const RETRYABLE_STATUS = new Set([429, 503]);

// Build a fetch wrapper. `fetchImpl`, `timeoutMs`, and (via `cfg`) `maxRetries` / `sleep`
// are injectable so the timeout AND retry behaviour can be unit-tested without a network.
// A caller-supplied `opts.signal` is respected as-is (no timeout added, no auto-retry) so
// explicit cancellation still works.
export function makeFigmaFetch(fetchImpl = globalThis.fetch, timeoutMs = FIGMA_FETCH_TIMEOUT_MS, cfg = {}) {
  const maxRetries = cfg.maxRetries ?? FIGMA_FETCH_MAX_RETRIES;
  const capMs      = cfg.backoffCapMs ?? FIGMA_FETCH_BACKOFF_CAP_MS;
  const sleep      = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  return async function figmaFetch(url, opts = {}) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, { ...opts, signal: opts.signal || AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        if (e && (e.name === 'TimeoutError' || e.name === 'AbortError'))
          throw new Error(`Figma API did not respond within ${timeoutMs / 1000}s (rate limit or network stall)`);
        throw e;
      }
      // Return unless it is a retryable throttle we still have budget for. A caller-supplied
      // signal means the caller controls the lifecycle, so never auto-retry under it.
      if (!RETRYABLE_STATUS.has(res.status) || attempt >= maxRetries || opts.signal) return res;
      // Honour Retry-After (seconds); otherwise exponential backoff with jitter, capped.
      const ra = parseInt(res.headers?.get?.('retry-after') ?? '', 10);
      const waitMs = Number.isFinite(ra) && ra >= 0
        ? Math.min(ra * 1000, capMs)
        : Math.min(1000 * 2 ** attempt, capMs) + Math.floor(Math.random() * 250);
      await sleep(waitMs);
    }
  };
}
