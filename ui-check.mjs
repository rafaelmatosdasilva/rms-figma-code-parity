// ui-check.mjs - check a generated UI against the design system's component catalog.
// Run from project root:  node ../rms-figma-code-parity/ui-check.mjs <generated.json> [--json]
//                     or: rms-figma-code-parity --check-ui <generated.json>
//
// The catalog is contracts/catalog.json (written by every audit run). The check is deterministic
// and prompt-blind: it never repairs the UI and never adds anything; it lists every finding with the
// rule it breaks. The findings are also written to .parity-out/ui-check.json, so a generation log
// can keep them beside the raw output.
//
// Exit 0 = valid (warnings allowed). Exit 1 = at least one error. Exit 2 = no catalog or no input.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkUi, RULES } from './ui-catalog.mjs';

const ROOT = process.cwd();
const args = process.argv.slice(2).filter((a) => a !== '--check-ui');
const JSON_MODE = args.includes('--json');
const input = args.find((a) => !a.startsWith('--'));

let cfg = {};
try { cfg = JSON.parse(readFileSync(join(ROOT, 'ds-config.json'), 'utf8')); } catch { /* defaults */ }
const catalogPath = resolve(ROOT, cfg.contracts?.out ?? 'contracts', 'catalog.json');

if (!input || !existsSync(resolve(ROOT, input))) {
  console.log('\nUsage: rms-figma-code-parity --check-ui <generated-ui.json>');
  console.log('   The file is the UI a generator produced: a flat { root, components: [{ id, component, children, …props }] }');
  console.log('   list (A2UI style) or a nested { component, props, children } tree.\n');
  process.exit(2);
}
if (!existsSync(catalogPath)) {
  console.log(`\n⏭  ${catalogPath.replace(ROOT + '/', '')} not found. Run the audit once: it writes the catalog beside the contracts.\n`);
  process.exit(2);
}

let ui;
try { ui = JSON.parse(readFileSync(resolve(ROOT, input), 'utf8')); }
catch (e) { console.log(`\n❌ ${input} is not valid JSON (${e.message.split('\n')[0]}). Nothing was checked.\n`); process.exit(1); }

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const r = checkUi(ui, catalog);
try {
  mkdirSync(join(ROOT, '.parity-out'), { recursive: true });
  writeFileSync(join(ROOT, '.parity-out', 'ui-check.json'), JSON.stringify({ input, checked: new Date().toISOString(), ...r }, null, 2) + '\n');
} catch { /* the report file is optional */ }

if (JSON_MODE) { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); process.exit(r.ok ? 0 : 1); }

console.log(`\nGenerated UI check  ·  ${input}  ·  ${r.counts.components} component(s)`);
console.log(`${r.ok ? '✅' : '❌'} ${r.counts.errors} error(s) · ${r.counts.warnings} warning(s)`);
for (const f of r.findings) console.log(`   ${f.level === 'error' ? '❌' : '⚠️ '} ${f.message}  (rule ${f.rule}: ${RULES[f.rule - 1]})`);
console.log('');
process.exit(r.ok ? 0 : 1);
