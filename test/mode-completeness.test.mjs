import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const GATE = fileURLToPath(new URL('../mode-completeness-check.mjs', import.meta.url));

// Build a throwaway project fixture and run the gate against it (cwd = fixture).
// Returns { code, out }. The gate reads ds-config.json / parity-map.mjs / the snapshot from cwd.
function runGate({ themeCss, snapshot, config }) {
  const dir = mkdtempSync(join(tmpdir(), 'mode-gate-'));
  writeFileSync(join(dir, 'ds-config.json'), JSON.stringify(config));
  writeFileSync(join(dir, 'parity-map.mjs'), 'export const EXPLICIT={};export const SKIP_TOKENS=new Set();');
  writeFileSync(join(dir, 'theme.css'), themeCss);
  writeFileSync(join(dir, 'figma-vars.snapshot.json'), JSON.stringify(snapshot));
  try {
    const out = execFileSync('node', [GATE], { cwd: dir, encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const CONFIG = {
  paths: { themeCSS: 'theme.css', snapshotVars: 'figma-vars.snapshot.json' },
  figma: {
    colorCollection: 'Color',
    modes: [
      { name: 'Light', snapshotKey: 'light', cssSelector: 'root' },
      { name: 'Dark', snapshotKey: 'dark', cssSelector: 'dark-media' },
    ],
    collections: [
      { name: 'Breakpoint', kind: 'scalar', modes: [
        { name: 'Phone', snapshotKey: 'phone', cssSelector: 'root' },
        { name: 'Tablet', snapshotKey: 'tablet', cssSelector: 'media:(min-width: 768px)' },
      ] },
    ],
  },
};

const SNAPSHOT = {
  color: { light: { 'brand/color': '#ff0000' }, dark: { 'brand/color': '#00ff00' } },
  modeVariants: {
    Breakpoint: {
      modes: [{ name: 'Phone', snapshotKey: 'phone' }, { name: 'Tablet', snapshotKey: 'tablet' }],
      vars: { 'gap/m': { kind: 'scalar', values: { phone: '8px', tablet: '12px' } } },
    },
  },
};

test('passes when a per-breakpoint sizing var has its media override in CSS', () => {
  const themeCss = `
    :root { --brand: #ff0000; --gap-m: 8px; }
    @media (prefers-color-scheme: dark) { :root { --brand: #00ff00; } }
    @media (min-width: 768px) { :root { --gap-m: 12px; } }
  `;
  const { code, out } = runGate({ themeCss, snapshot: SNAPSHOT, config: CONFIG });
  assert.equal(code, 0, out);
  assert.match(out, /Breakpoint\[phone\/tablet\]/);
});

test('fails when the sizing var varies in Figma but the CSS media override is missing', () => {
  const themeCss = `
    :root { --brand: #ff0000; --gap-m: 8px; }
    @media (prefers-color-scheme: dark) { :root { --brand: #00ff00; } }
  `; // no @media (min-width: 768px) override → gap-m is 8px in both breakpoints
  const { code, out } = runGate({ themeCss, snapshot: SNAPSHOT, config: CONFIG });
  assert.equal(code, 1, out);
  assert.match(out, /\[Breakpoint\] gap\/m/);
  assert.match(out, /resolves to 8px in both phone and tablet/);
});

test('a mixed-type collection checks each var by its own kind (scalar + string vary light/dark)', () => {
  // A "Theme"-like collection sharing the light/dark axis, whose scalar and string vars also vary.
  const config = {
    paths: { themeCSS: 'theme.css', snapshotVars: 'figma-vars.snapshot.json' },
    figma: {
      colorCollection: 'Theme',
      modes: [
        { name: 'Light', snapshotKey: 'light', cssSelector: 'root' },
        { name: 'Dark', snapshotKey: 'dark', cssSelector: 'dark-media' },
      ],
      collections: [
        { name: 'Theme', modes: [
          { name: 'Light', snapshotKey: 'light', cssSelector: 'root' },
          { name: 'Dark', snapshotKey: 'dark', cssSelector: 'dark-media' },
        ] },
      ],
    },
  };
  const snapshot = {
    color: { light: {}, dark: {} },
    modeVariants: {
      Theme: {
        modes: [{ name: 'Light', snapshotKey: 'light' }, { name: 'Dark', snapshotKey: 'dark' }],
        vars: {
          'ring/width': { kind: 'scalar', values: { light: '1px', dark: '2px' } },   // varies
          'ring/label': { kind: 'string', values: { light: 'On', dark: 'Off' } },     // varies
        },
      },
    },
  };
  // CSS overrides ring/width per mode but NOT ring/label → label is the only failure.
  const themeCss = `
    :root { --ring-width: 1px; --ring-label: On; }
    @media (prefers-color-scheme: dark) { :root { --ring-width: 2px; } }
  `;
  const { code, out } = runGate({ themeCss, snapshot, config });
  assert.equal(code, 1, out);
  assert.match(out, /\[Theme\] ring\/label/);      // string var flagged
  assert.doesNotMatch(out, /ring\/width/);          // scalar var adapted → not flagged
});

test('a DS with no declared collections runs the colour-only check unchanged', () => {
  const cfg = { ...CONFIG, figma: { colorCollection: 'Color', modes: CONFIG.figma.modes } };
  const themeCss = `
    :root { --brand: #ff0000; }
    @media (prefers-color-scheme: dark) { :root { --brand: #00ff00; } }
  `;
  const snap = { color: SNAPSHOT.color };
  const { code, out } = runGate({ themeCss, snapshot: snap, config: cfg });
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /Breakpoint/);
});
