// codeconnect-check.mjs - validate Code Connect mappings against the contract (I31).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNodeId, parseCodeConnect, codeConnectFindings } from '../codeconnect-check.mjs';

test('normalizeNodeId canonicalizes every node-id form', () => {
  assert.equal(normalizeNodeId('789-35349'), '789:35349');
  assert.equal(normalizeNodeId('789:35349'), '789:35349');
  assert.equal(normalizeNodeId('789%3A35349'), '789:35349');
  assert.equal(normalizeNodeId('https://figma.com/design/K/x?node-id=12-34&t=1'), '12:34');
  assert.equal(normalizeNodeId(''), null);
});

test('parseCodeConnect extracts component, node id, and prop mappings with enum options', () => {
  const src = `
    import figma from '@figma/code-connect';
    import { Button } from './Button';
    figma.connect(Button, 'https://www.figma.com/design/ABC/DS?node-id=789-35349', {
      props: {
        size: figma.enum('Size', { Small: 'sm', Large: 'lg' }),
        disabled: figma.boolean('Disabled'),
        label: figma.string('Label'),
      },
      example: (p) => <Button size={p.size} />,
    });
  `;
  const [e] = parseCodeConnect(src);
  assert.equal(e.component, 'Button');
  assert.equal(e.nodeId, '789:35349');
  const size = e.props.find((p) => p.figmaProp === 'Size');
  assert.deepEqual(size.options.sort(), ['Large', 'Small']);
  assert.ok(e.props.some((p) => p.figmaProp === 'Disabled' && p.kind === 'boolean'));
  assert.ok(e.props.some((p) => p.figmaProp === 'Label' && p.kind === 'string'));
  assert.deepEqual(parseCodeConnect('no connect here'), []);
});

test('codeConnectFindings flags unknown prop, unknown option, and a node with no contract', () => {
  const contracts = [{
    id: 'rms.Button', figmaNodeId: '789:35349',
    props: [{ name: 'Size', bindings: { figma: { property: 'Size' } }, options: ['Small', 'Large'] }],
  }];
  const entries = [
    { component: 'Button', nodeId: '789:35349', props: [
      { figmaProp: 'Size', kind: 'enum', options: ['Small', 'Huge'] },   // Huge is stale
      { figmaProp: 'Tone', kind: 'enum', options: ['brand'] },           // Tone does not exist
    ] },
    { component: 'Ghost', nodeId: '111:222', props: [] },                // no contract for this node
  ];
  const { findings, checked, matched } = codeConnectFindings(entries, contracts);
  assert.equal(checked, 2);
  assert.equal(matched, 1);
  assert.ok(findings.some((f) => f.kind === 'unknown-option' && f.option === 'Huge' && f.figmaProp === 'Size'));
  assert.ok(findings.some((f) => f.kind === 'unknown-prop' && f.figmaProp === 'Tone'));
  assert.ok(findings.some((f) => f.kind === 'no-contract' && f.component === 'Ghost'));
  // a valid option is not flagged
  assert.ok(!findings.some((f) => f.option === 'Small'));
});

test('codeConnectFindings: a fully-correct mapping produces no findings', () => {
  const contracts = [{ figmaNodeId: '1:2', props: [{ name: 'Size', options: ['sm', 'md'] }] }];
  const entries = [{ component: 'X', nodeId: '1:2', props: [{ figmaProp: 'Size', kind: 'enum', options: ['sm', 'md'] }] }];
  const r = codeConnectFindings(entries, contracts);
  assert.deepEqual(r.findings, []);
  assert.equal(r.matched, 1);
});
