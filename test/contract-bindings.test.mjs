// Phase B — Gate 14 reads authored Figma->code bindings from the emitted contract
// (contracts/<name>.contract.json → props[].bindings.code) and treats them as ground
// truth: a renamed attribute or a renamed slot the name-inference cannot resolve.
// Guardrail: a binding that points at a code target that does not exist is NOT a pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGate } from './helpers.mjs';

const GATE = 'component-prop-check.mjs';
const rowsOf = (dir) => JSON.parse(readFileSync(join(dir, 'component-prop-result.json'), 'utf8')).rows;
const find = (rs, name) => rs.find((r) => r.figmaProp === name);

// Figma "labelContent" (TEXT) and "trailingIcon" (INSTANCE_SWAP); the code names differ
// with NO substring overlap, so inference can only report them as missing/unresolved.
const BASE = {
  'ds-config.json': { paths: { snapshotVars: 'figma-vars.snapshot.json' }, componentSrcDirs: ['src'] },
  'figma-component-props.snapshot.json': { Widget: { properties: {
    labelContent: { type: 'TEXT' },
    trailingIcon: { type: 'INSTANCE_SWAP', defaultValue: 'x' },
  } } },
  'src/Widget.vue':
    '<script setup lang="ts">\n' +
    'defineProps<{ caption?: string }>()\n' +
    '</script>\n<template><div class="widget"><slot name="end"></slot></div></template>\n',
};

// Authored bindings live in the COMMITTED contract.authored.json (the hub), not the local views.
const contractFile = (attr, slot) => ({
  'contract.authored.json': {
    components: {
      Widget: { bindings: {
        labelContent: { attribute: attr },
        trailingIcon: { slot },
      } },
    },
  },
});

test('[Phase B] without a contract, a non-obvious rename + a renamed slot fail (inference cannot resolve them)', () => {
  const { code, dir, out } = runGate(GATE, BASE);
  assert.equal(code, 1, out);
  assert.equal(find(rowsOf(dir), 'labelContent').status, 'missing', out);
  assert.equal(find(rowsOf(dir), 'trailingIcon').status, 'missing', out);
});

test('[Phase B] an authored contract binding resolves the rename and the slot -> gate passes', () => {
  const { code, dir, out } = runGate(GATE, { ...BASE, ...contractFile('caption', 'end') });
  assert.equal(code, 0, out);
  const rs = rowsOf(dir);
  assert.equal(find(rs, 'labelContent').status, 'match', out);
  assert.equal(find(rs, 'labelContent').codeProp, 'caption', out);
  assert.equal(find(rs, 'trailingIcon').status, 'match', out);
  assert.equal(find(rs, 'trailingIcon').codeProp, 'end', out);
});

test('[Phase B guardrail] a binding pointing at a code target that does not exist is NOT a pass', () => {
  const { code } = runGate(GATE, { ...BASE, ...contractFile('nope', 'nope') });
  assert.equal(code, 1);   // silence is never a pass: a wrong binding cannot mask an absent target
});
