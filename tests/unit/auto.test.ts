import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretAutomaticAttempt } from '../../src/auto.ts';
import type { ActionSpec, Answer } from '../../src/types.ts';

const candidate = (): ActionSpec => ({
  actionId: 'a1', identityVersion: 2, templateId: 'acquire_secure', actingActorId: 'player', playerActorId: 'player', targetActorIds: [],
  attemptedAction: 'I climb the locked gate and drop inside.', requestedGain: 'the first primary uncertain, consequential state change explicitly attempted in the latest user message',
  applicability: 'favorable', uncertainConsequential: true, opposed: false, resolutionScope: 'attempt', sceneId: 1, persistentFactKey: '',
  failureStake: { kind: 'other', detail: 'Failure moves the scene.' }, availableEvidence: '', preconditions: [],
});

const choice = (value: string): Answer => ({ type: 'choice', choice: value, probabilities: null, confidence: null, provenance: 'fixture' });

test('automatic gate skips dialogue/trivial activity without creating a ruling', () => {
  assert.deepEqual(interpretAutomaticAttempt(candidate(), { attempt_gate: choice('none'), attempt_family: choice('none') }), { ok: true, action: null, reason: 'none' });
  assert.deepEqual(interpretAutomaticAttempt(candidate(), { attempt_gate: choice('trivial_or_certain'), attempt_family: choice('overcome_operate') }), { ok: true, action: null, reason: 'trivial_or_certain' });
});

test('automatic gate classifies one attempt and defers bundled attempts after the first', () => {
  const one = interpretAutomaticAttempt(candidate(), { attempt_gate: choice('one_consequential'), attempt_family: choice('overcome_operate') });
  assert.ok(one.ok && one.action);
  assert.equal(one.action.templateId, 'overcome_operate');
  assert.equal(one.action.additionalAttemptsPolicy, undefined);
  const many = interpretAutomaticAttempt(candidate(), { attempt_gate: choice('multiple_consequential'), attempt_family: choice('contest_impose') });
  assert.ok(many.ok && many.action);
  assert.equal(many.action.templateId, 'contest_impose');
  assert.equal(many.action.additionalAttemptsPolicy, 'defer_after_first');
});

test('automatic gate fails closed on missing or unsupported answers', () => {
  assert.equal(interpretAutomaticAttempt(candidate(), {}, { attempt_gate: 'missing' }).ok, false);
  assert.equal(interpretAutomaticAttempt(candidate(), { attempt_gate: choice('one_consequential'), attempt_family: choice('none') }).ok, false);
  assert.equal(interpretAutomaticAttempt(candidate(), { attempt_gate: choice('invented'), attempt_family: choice('acquire_secure') }).ok, false);
});
