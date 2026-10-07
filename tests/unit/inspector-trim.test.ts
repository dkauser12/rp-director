import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, newRecord, normalizeRecord } from '../../src/state.ts';
import type { InspectorEntry } from '../../src/types.ts';

function entry(i: number): InspectorEntry {
  return {
    id: `ins${i}`, at: i, epoch: 0, kind: 'director_send', message: `turn ${i}`, attemptId: null, resolutionId: null, actionId: null,
    applicability: null, questions: {}, stateSent: { transcript: 'x'.repeat(10000) }, answers: {},
    speaker: null, policyBandId: 'band', draw: 0.5, outcome: 'at_a_price', injectedText: 'ruling',
    providerKind: 'mock', requestedModel: null, returnedModel: null, durationMs: 300, inputTokens: null, outputTokens: null, networkCalls: 1,
  };
}

test('34: a loaded record retains only the eight newest full inspector payloads', () => {
  const inspector = Array.from({ length: 200 }, (_, i) => entry(i));
  const original = structuredClone(inspector);
  const record = normalizeRecord({ schemaVersion: 1, seedId: 'seed', inspector }, 'seed', 'rev');
  assert.equal(record.inspector.length, 200);
  assert.equal(record.inspector.filter(e => e.stateSent !== null).length, 8);
  assert.deepEqual(record.inspector.slice(-8), inspector.slice(-8));
  assert.equal(record.inspector[0]!.questions, null);
  assert.equal(record.inspector[0]!.injectedText, null);
  assert.equal(record.inspector[0]!.outcome, 'at_a_price');
  assert.equal(record.inspector[0]!.answers, null, 'old raw answers share the bounded detail window');
  assert.ok(JSON.stringify(record.inspector).length < JSON.stringify(inspector).length / 5);
  assert.deepEqual(inspector, original, 'loading never mutates the rollback source');
});

test('34: appending inspector entries trims old payloads and keeps 200 summaries', () => {
  let record = newRecord('seed', 'rev');
  for (let i = 0; i < 205; i++) record = applyEvent(record, { type: 'inspect', entry: entry(i) }).record;
  assert.equal(record.inspector.length, 200);
  assert.equal(record.inspector[0]!.id, 'ins5');
  assert.deepEqual(record.inspector.filter(e => e.stateSent !== null).map(e => e.id), Array.from({ length: 8 }, (_, i) => `ins${197 + i}`));
});
