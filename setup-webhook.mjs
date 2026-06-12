// setup-webhook.mjs — Register a Figma webhook that points at webhook-server.mjs.
// Run once after deploying webhook-server.mjs to a public URL.
//
// Usage:
//   FIGMA_TOKEN=xxx node scripts/setup-webhook.mjs --url https://your-host.com/webhook
//
// Options:
//   --url <url>     Public URL of your running webhook-server.mjs endpoint (required)
//   --list          List existing webhooks for this file and exit
//   --delete <id>   Delete a webhook by ID and exit
//
// Reads from ds-config.json:
//   figmaFileKey    — the Figma file to watch
//   webhook.secret  — passcode sent with every event (or FIGMA_WEBHOOK_SECRET env var)

import { readFileSync } from 'fs';
import { join }         from 'path';

const ROOT  = process.cwd();
const TOKEN = process.env.FIGMA_TOKEN;

if (!TOKEN) {
  console.error('❌ FIGMA_TOKEN env var required');
  process.exit(1);
}

let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch {
  console.error('❌ ds-config.json not found at project root.'); process.exit(1);
}

const FILE_KEY = cfg.figmaFileKey;
const SECRET   = cfg.webhook?.secret ?? process.env.FIGMA_WEBHOOK_SECRET ?? 'rms-parity';

if (!FILE_KEY) { console.error('❌ figmaFileKey missing in ds-config.json'); process.exit(1); }

const args = process.argv.slice(2);

// ── --list ────────────────────────────────────────────────────────────────────
if (args.includes('--list')) {
  const resp = await fetch(`https://api.figma.com/v2/files/${FILE_KEY}/webhooks`, {
    headers: { 'X-Figma-Token': TOKEN },
  });
  const data = await resp.json();
  if (!resp.ok) { console.error('❌', JSON.stringify(data)); process.exit(1); }
  const hooks = data.webhooks ?? [];
  if (!hooks.length) { console.log('No webhooks registered for this file.'); process.exit(0); }
  console.log(`\n${hooks.length} webhook(s) for file ${FILE_KEY}:\n`);
  for (const h of hooks)
    console.log(`  ${h.id}  ${h.event_type.padEnd(25)}  ${h.status.padEnd(8)}  ${h.endpoint}`);
  console.log('');
  process.exit(0);
}

// ── --delete <id> ─────────────────────────────────────────────────────────────
const delIdx = args.indexOf('--delete');
if (delIdx !== -1) {
  const id = args[delIdx + 1];
  if (!id) { console.error('❌ Usage: --delete <webhook-id>'); process.exit(1); }
  const resp = await fetch(`https://api.figma.com/v2/webhooks/${id}`, {
    method: 'DELETE', headers: { 'X-Figma-Token': TOKEN },
  });
  if (resp.status === 200 || resp.status === 204) {
    console.log(`✅ Deleted webhook ${id}`);
  } else {
    const data = await resp.json().catch(() => ({}));
    console.error(`❌ Failed to delete: ${JSON.stringify(data)}`);
    process.exit(1);
  }
  process.exit(0);
}

// ── --url <url>: register webhooks ───────────────────────────────────────────
const urlIdx = args.indexOf('--url');
const hookUrl = urlIdx !== -1 ? args[urlIdx + 1] : null;
if (!hookUrl) {
  console.error('❌ Usage: node scripts/setup-webhook.mjs --url https://your-host.com/webhook');
  console.error('   Other options: --list, --delete <id>');
  process.exit(1);
}

const EVENTS = ['FILE_UPDATE', 'LIBRARY_PUBLISH', 'FILE_VERSION_UPDATE'];

console.log(`\nRegistering ${EVENTS.length} webhook(s) for file ${FILE_KEY}...\n`);

for (const event of EVENTS) {
  const body = {
    event_type:  event,
    endpoint:    hookUrl,
    passcode:    SECRET,
    status:      'ACTIVE',
    description: `rms-parity ${event}`,
  };

  const resp = await fetch('https://api.figma.com/v2/webhooks', {
    method:  'POST',
    headers: { 'X-Figma-Token': TOKEN, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const data = await resp.json();

  if (data.id) {
    console.log(`  ✅ ${event.padEnd(30)} ID: ${data.id}`);
  } else {
    console.error(`  ❌ ${event.padEnd(30)} ${JSON.stringify(data)}`);
  }
}

console.log(`\nDone. To list: node scripts/setup-webhook.mjs --list\n`);
