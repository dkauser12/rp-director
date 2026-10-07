import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStatusChip } from '../../src/status-chip.ts';
import type { StatusChipInput } from '../../src/status-chip.ts';

const ready: StatusChipInput = {
  enabled: true, paused: false, hasChat: true, status: 'Ready', lastError: null,
  connectionConfigured: true, connectionWorking: true,
};

test('drawer reports user controls before stale activity or error state', () => {
  const stale = { ...ready, status: 'Writing' as const, lastError: 'network failure' };
  assert.equal(buildStatusChip({ ...stale, enabled: false }).state, 'off');
  assert.equal(buildStatusChip({ ...stale, hasChat: false }).state, 'no-chat');
  assert.equal(buildStatusChip({ ...stale, paused: true }).state, 'paused');
});

test('drawer distinguishes missing configuration from an untested and working connection', () => {
  const missing = buildStatusChip({ ...ready, connectionConfigured: false, connectionWorking: false });
  const untested = buildStatusChip({ ...ready, connectionWorking: false });
  const working = buildStatusChip(ready);
  assert.equal(missing.label, 'Not connected');
  assert.equal(untested.label, 'Ready');
  assert.match(untested.nextStep, /check the judge connection/);
  assert.equal(untested.tone, 'neutral');
  assert.equal(working.tone, 'good');
  assert.notEqual(untested.nextStep, working.nextStep);
});

test('Deciding and Writing take precedence over an earlier partial judge failure', () => {
  for (const status of ['Deciding', 'Writing'] as const) {
    const result = buildStatusChip({ ...ready, status, lastError: 'network failure' });
    assert.equal(result.label, status);
    assert.equal(result.tone, 'active');
  }
  assert.deepEqual(buildStatusChip({ ...ready, status: 'Frozen' }), buildStatusChip(ready));
});

test('every drawer state has a safe next step and errors preserve the fail-open assurance', () => {
  const cases = [
    ['timeout', 'Judge unavailable: wait budget expired'],
    ['network', 'Judge unavailable: Failed to fetch'],
    ['refusal', 'Judge unavailable: model refused the request'],
    ['invalid', 'Judge unavailable: invalid answer batch'],
    ['budget', 'Judge unavailable: context exceeds the character budget'],
    ['writer', 'Writer tool request rejected: invalid action'],
    ['auth', 'HTTP 401: invalid API key'],
    ['error', 'Unexpected provider failure'],
  ] as const;
  const outputs = [
    buildStatusChip({ ...ready, enabled: false }),
    buildStatusChip({ ...ready, hasChat: false }),
    buildStatusChip({ ...ready, paused: true }),
    buildStatusChip({ ...ready, connectionConfigured: false }),
    buildStatusChip({ ...ready, status: 'Deciding' }),
    buildStatusChip({ ...ready, status: 'Writing' }),
    buildStatusChip({ ...ready, status: 'Frozen' }),
    buildStatusChip({ ...ready, connectionWorking: false }),
  ];
  for (const [expected, message] of cases) {
    const result = buildStatusChip({ ...ready, status: 'Error', lastError: `${message}: private-detail` });
    assert.equal(result.state, expected);
    assert.ok(result.nextStep.endsWith("Your chat isn't affected."));
    assert.equal(result.tone, 'warning');
    outputs.push(result);
  }
  for (const result of outputs) {
    assert.ok(result.label.trim());
    assert.ok(result.nextStep.trim());
    assert.match(result.nextStep, /\.$/);
    assert.doesNotMatch(`${result.label} ${result.nextStep}`, /private-detail|\b(?:projection|band|binding|observer|permit|baseline|provisional|commit|variant|cursor)\b/i);
  }
});

test('unknown and empty errors never leak details or claim that the connection works', () => {
  const absent = buildStatusChip({ ...ready, status: 'Error', lastError: null });
  assert.equal(absent.state, 'error');
  const details = buildStatusChip({ ...ready, lastError: '<script>private data</script>' });
  assert.equal(details.state, 'error');
  assert.doesNotMatch(details.nextStep, /script|private data/);
});
