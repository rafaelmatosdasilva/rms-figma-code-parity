import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameworkGateSkipReason } from '../component-framework-gate.mjs';

test('runs the gate for a framework project with a normal result (no skip)', () => {
  assert.equal(frameworkGateSkipReason(true, 0), null);   // frameworkComponents on, gate passed
  assert.equal(frameworkGateSkipReason(true, 1), null);   // gate ran and failed — still run it
  assert.equal(frameworkGateSkipReason(undefined, 0), null); // default (unset) = framework on
});

test('skips when the project opted out (frameworkComponents:false)', () => {
  const reason = frameworkGateSkipReason(false, 1);       // even a "fail" status is skipped
  assert.match(reason, /frameworkComponents:false/);
});

test('skips when the opt-in snapshot was never captured (exit 2)', () => {
  const reason = frameworkGateSkipReason(true, 2);
  assert.match(reason, /not captured/);
});

test('opt-out takes precedence over exit status', () => {
  assert.match(frameworkGateSkipReason(false, 2), /frameworkComponents:false/);
});
