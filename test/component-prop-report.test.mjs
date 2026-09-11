// Regression tests for the component-prop parity ROWS (the data behind the parity report table)
// and the icon slot-or-prop relaxation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGate } from './helpers.mjs';

const GATE = 'component-prop-check.mjs';
const FILES = {
  'ds-config.json': { paths: { snapshotVars: 'figma-vars.snapshot.json' }, componentSrcDirs: ['src'] },
  'figma-component-props.snapshot.json': { ButtonPrimary: { properties: {
    size:         { type: 'VARIANT', variantOptions: ['s', 'm', 'l'] },
    disabled:     { type: 'BOOLEAN' },
    labelContent: { type: 'TEXT' },
    icon:         { type: 'INSTANCE_SWAP', defaultValue: 'arrow-right' },
    loading:      { type: 'BOOLEAN' },
  } } },
  // code: `label` (rename of labelContent), `icon` as a PROP (not a slot), `block` extra, no `loading`
  'src/ButtonPrimary.vue':
    "<script setup lang=\"ts\">\n" +
    "defineProps<{ size?: 's'|'m'|'l'; disabled?: boolean; label?: string; icon?: string; block?: boolean }>()\n" +
    "</script>\n<template><button class=\"buttonPrimary\">x</button></template>\n",
};

const rowsOf = (dir) => JSON.parse(readFileSync(join(dir, 'component-prop-result.json'), 'utf8')).rows;
const find = (rs, name) => rs.find(r => r.figmaProp === name);

test('[bugfix icon] an INSTANCE_SWAP matches a code PROP (not assumed to be a slot)', () => {
  const { out, dir } = runGate(GATE, FILES);
  const icon = find(rowsOf(dir), 'icon');
  assert.equal(icon.status, 'match', out);      // old code SLOT_FAILed with no slot present
  assert.equal(icon.codeValue, 'prop', out);    // reports the real representation
});

test('[report] rows classify match / rename / missing / extra', () => {
  const rs = rowsOf(runGate(GATE, FILES).dir);
  assert.equal(find(rs, 'size').status, 'match');
  assert.equal(find(rs, 'disabled').status, 'match');
  assert.equal(find(rs, 'labelContent').status, 'rename');
  assert.equal(find(rs, 'labelContent').codeProp, 'label');
  assert.equal(find(rs, 'loading').status, 'missing');
  assert.equal(find(rs, 'loading').codeProp, 'not in code');
  const extra = rs.find(r => r.status === 'extra');
  assert.equal(extra.codeProp, 'block');
  assert.equal(extra.figmaProp, 'not in Figma');
});

test('[regression] real divergences still fail the gate (exit 1)', () => {
  assert.equal(runGate(GATE, FILES).code, 1);
});

test('[bugfix empty] an empty props snapshot is "not verified", not a false pass', () => {
  const { code, out, dir } = runGate(GATE, {
    'ds-config.json': { paths: { snapshotVars: 'figma-vars.snapshot.json' } },
    'figma-component-props.snapshot.json': { _updated: '2020-01-01' },   // no components
  });
  assert.equal(code, 2, out);                       // not run, never exit 0
  assert.match(out, /not verified/i, out);
  const r = JSON.parse(readFileSync(join(dir, 'component-prop-result.json'), 'utf8'));
  assert.equal(r.empty, true);
});
