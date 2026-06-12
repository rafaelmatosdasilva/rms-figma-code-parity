// webhook-server.mjs — HTTP server that receives Figma webhook events and
// triggers an automated parity check when the DS file changes.
//
// Usage:
//   node scripts/webhook-server.mjs
//
// Register the webhook once with:
//   FIGMA_TOKEN=xxx node scripts/setup-webhook.mjs --url https://your-host/webhook
//
// Config (ds-config.json):
//   webhook.port    — port to listen on (default: 3456)
//   webhook.secret  — passcode Figma sends in every event (must match registration)
//   or: FIGMA_WEBHOOK_SECRET env var
//
// Handled events: FILE_UPDATE, LIBRARY_PUBLISH, FILE_VERSION_UPDATE
// On event: runs parity-check.mjs and visual-regression-check.mjs, logs result.

import { createServer }                    from 'http';
import { readFileSync }                    from 'fs';
import { join, dirname, resolve as resolvePath } from 'path';
import { fileURLToPath }                   from 'url';
import { spawnSync }                       from 'child_process';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT       = process.cwd();

// ── Load ds-config.json ───────────────────────────────────────────────────────
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

const PORT   = cfg.webhook?.port   ?? 3456;
const SECRET = cfg.webhook?.secret ?? process.env.FIGMA_WEBHOOK_SECRET ?? '';

if (!SECRET) {
  console.warn('⚠️  No webhook secret configured. All requests accepted.');
  console.warn('   Set webhook.secret in ds-config.json or FIGMA_WEBHOOK_SECRET env var.\n');
}

const HANDLED_EVENTS = new Set(['FILE_UPDATE', 'LIBRARY_PUBLISH', 'FILE_VERSION_UPDATE']);

// ── Run a script and return pass/fail ────────────────────────────────────────
function runScript(name) {
  const abs = resolvePath(SCRIPT_DIR, name);
  const r   = spawnSync('node', [abs], { cwd: ROOT, encoding: 'utf8' });
  return { pass: r.status === 0, out: (r.stdout + r.stderr).trim() };
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/webhook') {
    res.writeHead(req.method === 'GET' && req.url === '/health' ? 200 : 404);
    res.end(req.url === '/health' ? 'OK' : '');
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body); } catch {
      res.writeHead(400); res.end('Bad JSON');
      return;
    }

    // Figma uses a plain passcode (not HMAC)
    if (SECRET && payload.passcode !== SECRET) {
      console.log(`[${new Date().toISOString()}] ⚠️  Wrong passcode — rejected`);
      res.writeHead(401); res.end('Unauthorized');
      return;
    }

    const event   = payload.event_type ?? 'UNKNOWN';
    const fileKey = payload.file_key   ?? '?';
    const ts      = new Date().toISOString();

    console.log(`\n[${ts}] 📡 ${event}  file: ${fileKey}`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ received: true, event }));

    if (!HANDLED_EVENTS.has(event)) {
      console.log(`  ⏭ Event not handled — skipping`);
      return;
    }

    // Run parity check
    console.log('  🔄 Running parity-check.mjs...');
    const pc = runScript('parity-check.mjs');
    console.log(pc.pass ? '  ✅ Token parity OK' : '  ❌ Token parity FAIL — run /rms-parity to audit');

    // Run visual regression check (only if FIGMA_TOKEN set)
    if (process.env.FIGMA_TOKEN) {
      console.log('  🔄 Running visual-regression-check.mjs...');
      const vr = runScript('visual-regression-check.mjs');
      console.log(vr.pass ? '  ✅ Visual regression OK' : '  ❌ Visual regression FAIL — inspect .parity-refs/*.new.png');
    }

    console.log('  Done.\n');
  });
});

server.listen(PORT, () => {
  console.log(`\n📡 rms-parity webhook server`);
  console.log(`   Listening: http://localhost:${PORT}/webhook`);
  console.log(`   Health:    http://localhost:${PORT}/health`);
  console.log(`   Events:    ${[...HANDLED_EVENTS].join(', ')}`);
  console.log(SECRET ? `   Secret:    configured ✓` : `   Secret:    ⚠️  none`);
  console.log('');
});
