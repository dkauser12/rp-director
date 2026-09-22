import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, emptyState, newRecord } from '../../src/state.ts';
import { freeze } from '../../src/resolver.ts';
import type { ActionSpec, DirectorChatRecord, ObservationRecord } from '../../src/types.ts';

const action: ActionSpec = {
  actionId: 'act1', templateId: 'acquire_secure', playerActorId: 'player', actingActorId: 'player', targetActorIds: [],
  attemptedAction: 'takes the key', requestedGain: 'the key is secured', applicability: 'favorable', resolutionScope: 'attempt', preconditions: [],
  effectsByOutcome: { deferred: [], progress_only: [], achieved: [{ op: 'set_enum', variableId: 'gain:act1', value: 'achieved' }] },
};

const resolution = freeze({
  resolutionId: 'r1', previousResolutionId: null, action,
  snapshot: { chatId: 'chat', cursorBefore: 'c0', stateRevision: 0, scopeId: 'shared-public', profileRevision: 'p1', catalogRevision: '', actorBindingRevision: '', state: {} },
  assessment: { type: 'noul', noul: 0.9, confidence: null, provenance: 'fixture' }, decisionSource: 'provider' as const, policyRevision: 'p1',
  band: null, method: 'threshold' as const, draw: null, outcome: 'achieved', cursorBefore: null, generation: 1,
  providerKind: 'mock' as const, requestedModel: null, returnedModel: null, now: 1,
});

function apply(record: DirectorChatRecord, event: Parameters<typeof applyEvent>[1]): DirectorChatRecord {
  return applyEvent(record, event).record;
}

function observedRecord(): { record: DirectorChatRecord; observation: ObservationRecord } {
  let record = newRecord('seed', 'p1');
  record = apply(record, { type: 'set_baseline', cursor: 'c0', state: emptyState(), reason: 'test' });
  record = apply(record, { type: 'prepare', resolution, action, attemptId: 'a1', actorId: 'npc', epoch: 1, composerText: '', now: 1 });
  record = apply(record, { type: 'bind', attemptId: 'a1', cursorBefore: 'c0', epoch: 1, injectedText: 'binding', toolOffered: true });
  record = apply(record, { type: 'completed', attemptId: 'a1', epoch: 1, operationId: 'complete:a1', variantId: 'v1', hostMessageRef: 1, hostVariantRef: 0, cursorAfter: 'c1', now: 2, observerRequired: true });
  const observation: ObservationRecord = {
    schemaVersion: 1, requestId: 'oq', attemptId: 'a1', variantId: 'v1', baseCursor: 'c0', cursorAfter: 'c1', stateRevision: 0,
    realizedResolutionIds: ['r1'],
    operations: [{ operationId: 'obsop-time', op: 'advance_time', seconds: 30, quality: 'estimated' }],
    unresolved: [], providerKind: 'local', requestedModel: null, returnedModel: null, durationMs: 0, inputTokens: null, outputTokens: null,
  };
  return { record, observation };
}

test('live completion and ready observation remain provisional; observer commit is the only writer', () => {
  const prepared = observedRecord();
  assert.equal(prepared.record.attempts.a1!.status, 'observing');
  assert.equal(prepared.record.projection.state.variables['gain:act1'], undefined);
  assert.equal(prepared.record.projection.state.elapsedSeconds, 0);
  let record = apply(prepared.record, { type: 'observation_ready', attemptId: 'a1', variantId: 'v1', observation: prepared.observation });
  assert.equal(record.attempts.a1!.status, 'provisional');
  assert.equal(record.projection.state.variables['gain:act1'], undefined);
  assert.equal(record.projection.state.elapsedSeconds, 0);
  record = apply(record, { type: 'commit_observation', variantId: 'v1', operationId: 'commit:v1', now: 3 });
  assert.equal(record.attempts.a1!.status, 'accepted');
  assert.equal(record.projection.state.variables['gain:act1'], 'achieved');
  assert.equal(record.projection.state.elapsedSeconds, 30);
  assert.equal(record.projection.state.revision, 1);
  assert.deepEqual(record.checkpoints.c1!.observationOperationIds, ['obsop-time']);
  const duplicate = apply(record, { type: 'commit_observation', variantId: 'v1', operationId: 'commit:v1', now: 4 });
  assert.equal(duplicate.projection.state.elapsedSeconds, 30);
  assert.equal(duplicate.projection.state.revision, 1);
});

test('observer failure preserves prose metadata and predecessor state while marking tracking stale', () => {
  const prepared = observedRecord();
  const failed = apply(prepared.record, { type: 'observation_failed', attemptId: 'a1', variantId: 'v1', error: 'timeout' });
  assert.equal(failed.variants.v1!.observerStatus, 'failed');
  assert.equal(failed.attempts.a1!.status, 'stale');
  assert.equal(failed.projection.status, 'stale');
  assert.equal(failed.projection.state.elapsedSeconds, 0);
  assert.ok(failed.variants.v1);
  const reloaded = apply(failed, { type: 'head_changed', cursor: 'c1', chain: ['c0', 'c1'], reason: 'load' });
  assert.equal(reloaded.projection.status, 'stale', 'reload must not hide a failed observation behind generic provisional state');
  assert.match(reloaded.projection.reason ?? '', /timeout/);
});

test('repairing a selected swipe baselines its missing predecessor before retrying observation', () => {
  let record = newRecord('seed', 'p1');
  const basis = emptyState();
  record = apply(record, { type: 'set_baseline', cursor: 'c-old-visible-head', state: basis, reason: 'first use after greeting' });
  record = apply(record, { type: 'regeneration_attempt', attemptId: 'a-swipe', resolutionId: null, cursorBefore: 'c-before-greeting', epoch: 1, generationType: 'swipe', actorId: 'npc', injectedText: '', unadjudicated: true, now: 1 });
  record = apply(record, { type: 'completed', attemptId: 'a-swipe', epoch: 1, operationId: 'complete-swipe', variantId: 'v-swipe', hostMessageRef: 0, hostVariantRef: 1, cursorAfter: 'c-new-greeting', now: 2, observerRequired: true });
  record = apply(record, { type: 'observation_failed', attemptId: 'a-swipe', variantId: 'v-swipe', error: 'the predecessor checkpoint is unavailable' });
  assert.equal(record.checkpoints['c-before-greeting'], undefined);
  assert.equal(record.projection.status, 'stale');

  record = apply(record, { type: 'set_baseline', cursor: 'c-before-greeting', state: record.projection.state, reason: 'repair selected swipe predecessor' });
  record = apply(record, { type: 'retry_observation', attemptId: 'a-swipe', variantId: 'v-swipe' });
  assert.ok(record.checkpoints['c-before-greeting']);
  assert.equal(record.attempts['a-swipe']!.status, 'observing');
  assert.equal(record.projection.status, 'provisional');
  assert.match(record.projection.reason ?? '', /retrying observer/);
});
