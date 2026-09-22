// intent-gen.mjs — external guidelines ingestion (guidance → INTENT).
// A committed guidelines doc (markdown or JSON) is folded into design-intent.json: a section whose
// heading matches a component name attaches to that component; the rest becomes the global block.
// Advisory, additive, and it degrades to a no-op when no guidelines are configured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeFixture } from './helpers.mjs';
import { generateIntent } from '../intent-gen.mjs';

const baseFiles = {
  'theme.css': ':root{}\n',
  'struct.json': { components: { buttonPrimary: { h: 24 } } },
  'props.json': { buttonPrimary: { properties: {}, annotations: [], props: [] } },
};
const cfg = (extra = {}) => ({
  paths: { themeCSS: 'theme.css', snapshotStructure: 'struct.json', compPropsSnapshot: 'props.json' },
  ...extra,
});

test('[guidelines md] a heading matching a component attaches to it; other sections go global', async () => {
  const dir = makeFixture({
    ...baseFiles,
    'guidelines.md':
      'Intro line before any heading.\n\n' +
      '# buttonPrimary\nUse for the primary action. Not for navigation.\n\n' +
      '# Getting started\nInstall the DS first.\n',
  });
  const r = await generateIntent(dir, cfg({ guidelines: { sources: ['guidelines.md'] } }), {});
  assert.equal(r.guidelineSources, 1, JSON.stringify(r));
  assert.equal(r.withGuidelines, 1);
  const intent = JSON.parse(readFileSync(r.out, 'utf8'));
  assert.match(intent.components.buttonPrimary.guidelines, /primary action/);
  // the non-component "Getting started" + the pre-heading intro land in the global block
  assert.match(intent.guidelines.general, /Getting started/);
  assert.match(intent.guidelines.general, /Intro line/);
  assert.ok(intent.guidelines._hash, 'a content hash is recorded');
});

test('[guidelines json] a JSON map keys sections by component, _general is global', async () => {
  const dir = makeFixture({
    ...baseFiles,
    'guidelines.json': { buttonPrimary: 'Primary CTA only.', _general: 'Prefer tokens over raw values.' },
  });
  const r = await generateIntent(dir, cfg({ guidelines: { sources: ['guidelines.json'] } }), {});
  assert.equal(r.withGuidelines, 1);
  const intent = JSON.parse(readFileSync(r.out, 'utf8'));
  assert.match(intent.components.buttonPrimary.guidelines, /Primary CTA only/);
  assert.match(intent.guidelines.general, /Prefer tokens/);
});

test('[guidelines none] no guidelines configured is a clean no-op', async () => {
  const dir = makeFixture({ ...baseFiles });
  const r = await generateIntent(dir, cfg(), {});
  assert.equal(r.guidelineSources, 0);
  assert.equal(r.withGuidelines, 0);
  const intent = JSON.parse(readFileSync(r.out, 'utf8'));
  assert.equal(intent.guidelines, undefined, 'no guidelines block when nothing is configured');
});
