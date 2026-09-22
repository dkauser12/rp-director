import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newRecord, normalizeRecord, applyEvent, activeResolutionForCursor, provisionalAttempts, emptyState } from '../../src/state.ts';
import type { DirectorEvent } from '../../src/state.ts';
import { freeze, gainVariableId } from '../../src/resolver.ts';
import type { ActionSpec, DirectorChatRecord, FrozenResolution, Outcome } from '../../src/types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(fs.readFileSync(path.join(here, '..', 'fixtures', 'lifecycle-vectors.json'), 'utf8')).cases as any[];
const vector = (id: string) => vectors.find(v => v.id === id);

const action = (id = 'act1'): ActionSpec => ({
  actionId: id, templateId: 'obtain_access', playerActorId: 'player', targetActorIds: ['oren'],
  attemptedAction: 'asks Oren for passage', requestedGain: 'passage now', applicability: 'favorable', preconditions: [],
  outcomeText: { deferred: { required: [], forbidden: [] }, progress_only: { required: [], forbidden: [] }, achieved: { required: [], forbidden: [] } },
  effectsByOutcome: { deferred: [], progress_only: [{ op: 'set_enum', variableId: `gain:${id}`, value: 'partial' }], achieved: [{ op: 'set_enum', variableId: `gain:${id}`, value: 'achieved' }] },
});

const resolution = (id: string, outcome: Outcome = 'deferred', cursorBefore: string | null = null, act = action()): FrozenResolution => freeze({
  resolutionId: id, previousResolutionId: null, action: act,
  snapshot: { chatId: 'chat-a', cursorBefore: cursorBefore ?? '', stateRevision: 0, scopeId: 'shared-public', profileRevision: 'p1', catalogRevision: '', actorBindingRevision: '', state: {} },
  assessment: { type: 'noul', noul: 0.35, confidence: null, provenance: 'fixture' }, decisionSource: 'provider', policyRevision: 'p1',
  band: null, method: 'threshold', draw: null, outcome, cursorBefore, generation: 1, providerKind: 'mock', requestedModel: 'mock', returnedModel: null, now: 1,
});

function run(record: DirectorChatRecord, events: DirectorEvent[]) {
  const notices: string[] = [];
  let r = record;
  for (const e of events) {
    const out = applyEvent(r, e);
    r = out.record;
    notices.push(...out.notices);
  }
  return { record: r, notices };
}

/** Director Send happy path up to a provisional reply. */
function sendToProvisional(outcome: Outcome = 'deferred') {
  const base = run(newRecord('seed', 'p1'), [{ type: 'set_baseline', cursor: 'c0', state: emptyState(), reason: 'test' }]).record;
  return run(base, [
    { type: 'prepare', resolution: resolution('r1', outcome), action: action(), attemptId: 'a1', actorId: 'oren', epoch: 1, composerText: 'let me through', now: 1 },
    { type: 'bind', attemptId: 'a1', cursorBefore: 'c0', epoch: 1, injectedText: 'block' },
    { type: 'completed', attemptId: 'a1', epoch: 1, operationId: 'op-a1', variantId: 'v1', hostMessageRef: 3, hostVariantRef: 0, cursorAfter: 'c1', now: 2 },
  ]);
}

test('prepare → bind → complete → accept commits once and applies declared effects', () => {
  const { record } = sendToProvisional('achieved');
  assert.equal(record.attempts.a1!.status, 'provisional');
  assert.equal(record.projection.status, 'provisional');
  assert.equal(record.resolutions.r1!.cursorBefore, 'c0');
  const accepted = run(record, [{ type: 'accept', attemptId: 'a1', operationId: 'op-accept-1', now: 3 }]).record;
  assert.equal(accepted.attempts.a1!.status, 'accepted');
  assert.equal(accepted.resolutions.r1!.status, 'accepted');
  assert.equal(accepted.projection.status, 'current');
  assert.equal(accepted.projection.cursor, 'c1');
  assert.equal(accepted.projection.state.variables['gain:act1'], 'achieved');
  assert.equal(accepted.projection.state.settledGains[gainVariableId(action())]!.outcome.name, 'achieved', 'legacy achieved rulings migrate to frozen persistent settlements');
  assert.deepEqual(accepted.projection.state.acceptedResolutionIds, ['r1']);
  assert.equal(accepted.checkpoints.c1!.acceptedResolutionId, 'r1');
  assert.equal(accepted.projection.state.sceneReplyCount, 1);
});

test('M1-01 / duplicate_commit vector: the same completion or acceptance delivered twice applies once', () => {
  const v = vector('duplicate_commit');
  assert.ok(v);
  const { record } = sendToProvisional('achieved');
  const twice = run(record, [
    { type: 'completed', attemptId: 'a1', epoch: 1, operationId: 'op-a1', variantId: 'v1', hostMessageRef: 3, hostVariantRef: 0, cursorAfter: 'c1', now: 2 },
    { type: 'accept', attemptId: 'a1', operationId: 'op-accept-1', now: 3 },
    { type: 'accept', attemptId: 'a1', operationId: 'op-accept-1', now: 4 },
  ]);
  assert.deepEqual(twice.record.appliedOperationIds, ['op-a1', 'op-accept-1']);
  assert.equal(twice.record.projection.state.sceneReplyCount, 1);
  assert.equal(twice.record.projection.state.revision, 1);
  assert.ok(twice.notices.some(n => /duplicate/.test(n)));
});

test('M3-16 / rejected_attempt vector: rejection commits no effects and keeps the frozen resolution for retry', () => {
  const { record } = sendToProvisional('achieved');
  const rejected = run(record, [{ type: 'reject', attemptId: 'a1' }]).record;
  assert.equal(rejected.attempts.a1!.status, 'rejected');
  assert.equal(rejected.variants.v1!.acceptance, 'rejected');
  assert.equal(rejected.projection.state.variables['gain:act1'], undefined);
  assert.deepEqual(rejected.projection.state.acceptedResolutionIds, []);
  assert.equal(rejected.resolutions.r1!.status, 'prepared');
  assert.equal(activeResolutionForCursor(rejected, 'c0')?.resolutionId, 'r1');
  assert.equal(rejected.checkpoints.c1, undefined);
});

test('M1-02 / changed_chat vector: a late result from another epoch mutates nothing', () => {
  const v = vector('changed_chat');
  assert.ok(v);
  const base = run(newRecord('seed', 'p1'), [
    { type: 'set_baseline', cursor: 'c0', state: emptyState(), reason: 'test' },
    { type: 'prepare', resolution: resolution('r1'), action: action(), attemptId: 'a1', actorId: 'oren', epoch: 1, composerText: '', now: 1 },
    { type: 'bind', attemptId: 'a1', cursorBefore: 'c0', epoch: 1, injectedText: 'block' },
  ]).record;
  const switched = run(base, [{ type: 'abort_epoch', epoch: 1, reason: 'chat switched' }]).record;
  assert.equal(switched.attempts.a1!.status, 'cancelled');
  assert.equal(switched.pending, null);
  const late = applyEvent(switched, { type: 'completed', attemptId: 'a1', epoch: 1, operationId: 'late', variantId: 'v9', hostMessageRef: 9, hostVariantRef: 0, cursorAfter: 'c9', now: 5 });
  assert.equal(late.changed, false);
  assert.equal(late.record.variants.v9, undefined);
  assert.equal(late.record.projection.cursor, 'c0');
});

test('M1-02: completion carrying a different epoch than the attempt is rejected', () => {
  const { record } = sendToProvisional();
  const out = applyEvent(record, { type: 'completed', attemptId: 'a1', epoch: 2, operationId: 'x', variantId: 'vx', hostMessageRef: 0, hostVariantRef: 0, cursorAfter: 'cx', now: 1 });
  assert.equal(out.changed, false);
});

test('M1-03: cancel during writing rejects the late result and keeps the frozen decision retryable', () => {
  const base = run(newRecord('seed', 'p1'), [
    { type: 'set_baseline', cursor: 'c0', state: emptyState(), reason: 'test' },
    { type: 'prepare', resolution: resolution('r1'), action: action(), attemptId: 'a1', actorId: 'oren', epoch: 1, composerText: '', now: 1 },
    { type: 'bind', attemptId: 'a1', cursorBefore: 'c0', epoch: 1, injectedText: 'block' },
    { type: 'cancel', attemptId: 'a1', epoch: 1, reason: 'disabled during inference' },
  ]).record;
  assert.equal(base.attempts.a1!.status, 'cancelled');
  const late = applyEvent(base, { type: 'completed', attemptId: 'a1', epoch: 1, operationId: 'late', variantId: 'v1', hostMessageRef: 1, hostVariantRef: 0, cursorAfter: 'c1', now: 2 });
  assert.equal(late.changed, false);
  assert.equal(activeResolutionForCursor(base, 'c0')?.resolutionId, 'r1');
});

test('M1-04: selecting a stored earlier swipe restores its exact checkpoint without new resolutions', () => {
  const accepted = run(sendToProvisional('achieved').record, [{ type: 'accept', attemptId: 'a1', operationId: 'acc1', now: 3 }]).record;
  // Wording regeneration: same resolution, second variant, deferred effects would differ if it re-rolled.
  const second = run(accepted, [
    { type: 'regeneration_attempt', attemptId: 'a2', resolutionId: 'r1', cursorBefore: 'c0', epoch: 1, generationType: 'swipe', actorId: 'oren', injectedText: 'block', unadjudicated: false, now: 4 },
    { type: 'completed', attemptId: 'a2', epoch: 1, operationId: 'op-a2', variantId: 'v2', hostMessageRef: 3, hostVariantRef: 1, cursorAfter: 'c1b', now: 5 },
    { type: 'accept', attemptId: 'a2', operationId: 'acc2', now: 6 },
  ]).record;
  assert.equal(Object.keys(second.resolutions).length, 1);
  assert.equal(second.projection.cursor, 'c1b');
  const back = run(second, [{ type: 'select_variant', variantId: 'v1', cursorAfter: 'c1', chain: ['c0', 'c1'] }]).record;
  assert.equal(back.projection.cursor, 'c1');
  assert.equal(back.projection.status, 'current');
  assert.deepEqual(back.projection.state, second.checkpoints.c1!.stateAfter);
  assert.equal(Object.keys(back.resolutions).length, 1);
});

test('a variant marker whose stored cursor does not match the message text is not trusted', () => {
  const accepted = run(sendToProvisional('achieved').record, [{ type: 'accept', attemptId: 'a1', operationId: 'acc', now: 3 }]).record;
  // The host cloned v1's marker into a new swipe slot whose text differs (cursor c1-other).
  const out = run(accepted, [{ type: 'select_variant', variantId: 'v1', cursorAfter: 'c1-other', chain: ['c0', 'c1-other'] }]);
  assert.equal(out.record.projection.status, 'unknown');
  assert.equal(out.record.projection.cursor, 'c1-other');
  assert.ok(out.notices.some(n => /does not match/.test(n)));
  const same = run(accepted, [{ type: 'select_variant', variantId: 'v1', cursorAfter: 'c1', chain: ['c0', 'c1'] }]).record;
  assert.equal(same.projection.status, 'current');
});

test('M1-05: editing an earlier message invalidates unaccepted suffix decisions and marks the head stale', () => {
  const { record } = sendToProvisional();
  const edited = run(record, [{ type: 'head_changed', cursor: 'cX', chain: ['c0x', 'cX'], reason: 'edit' }]);
  assert.equal(edited.record.projection.status, 'stale');
  assert.equal(edited.record.resolutions.r1!.status, 'invalidated');
  assert.equal(edited.record.attempts.a1!.status, 'stale');
  assert.ok(edited.notices.some(n => /invalidated/.test(n)));
  // Accepted history is untouched by the same event.
  const accepted = run(sendToProvisional().record, [{ type: 'accept', attemptId: 'a1', operationId: 'acc', now: 3 }]).record;
  const afterEdit = run(accepted, [{ type: 'head_changed', cursor: 'cY', chain: ['c0', 'cY'], reason: 'edit' }]).record;
  assert.equal(afterEdit.resolutions.r1!.status, 'accepted');
  assert.equal(afterEdit.checkpoints.c1!.acceptedResolutionId, 'r1');
});

test('M1-06: deleting the last message restores the surviving prefix checkpoint', () => {
  const accepted = run(sendToProvisional('achieved').record, [{ type: 'accept', attemptId: 'a1', operationId: 'acc', now: 3 }]).record;
  assert.equal(accepted.projection.state.variables['gain:act1'], 'achieved');
  const deleted = run(accepted, [{ type: 'head_changed', cursor: 'c0', chain: ['c0'], reason: 'delete' }]).record;
  assert.equal(deleted.projection.cursor, 'c0');
  assert.equal(deleted.projection.status, 'current');
  assert.equal(deleted.projection.state.variables['gain:act1'], undefined);
  assert.equal(deleted.checkpoints.c1?.acceptedResolutionId, 'r1', 'inactive records are retained for recovery');
});

test('M1-07: only records whose cursor matches the active prefix contribute', () => {
  const accepted = run(sendToProvisional('achieved').record, [{ type: 'accept', attemptId: 'a1', operationId: 'acc', now: 3 }]).record;
  const sibling = run(accepted, [{ type: 'head_changed', cursor: 'c-sibling', chain: ['c0', 'c-sibling'], reason: 'branch' }]).record;
  assert.equal(sibling.projection.status, 'unknown');
  assert.equal(sibling.projection.cursor, 'c-sibling');
});

test('M1-08: continue re-evaluates the extended variant as one head; the earlier delta is not re-added', () => {
  const accepted = run(sendToProvisional('achieved').record, [{ type: 'accept', attemptId: 'a1', operationId: 'acc', now: 3 }]).record;
  const cont = run(accepted, [
    { type: 'regeneration_attempt', attemptId: 'a3', resolutionId: 'r1', cursorBefore: 'c0', epoch: 1, generationType: 'continue', actorId: 'oren', injectedText: 'block', unadjudicated: false, now: 4 },
    { type: 'completed', attemptId: 'a3', epoch: 1, operationId: 'op-a3', variantId: 'v3', hostMessageRef: 3, hostVariantRef: 0, cursorAfter: 'c1-ext', now: 5 },
    { type: 'accept', attemptId: 'a3', operationId: 'acc3', now: 6 },
  ]).record;
  assert.equal(cont.projection.state.sceneReplyCount, 1, 'computed from the predecessor, not stacked on the old checkpoint');
  assert.deepEqual(cont.projection.state.acceptedResolutionIds, ['r1']);
});

test('M1-09: after reload a saved prepared resolution resumes without a new assessment or draw', () => {
  const { record } = sendToProvisional();
  const saved = JSON.parse(JSON.stringify(record));
  const loaded = normalizeRecord(saved, 'seed', 'p1');
  assert.equal(loaded.resolutions.r1!.status, 'prepared');
  assert.equal(loaded.resolutions.r1!.draw, null);
  assert.equal(activeResolutionForCursor(loaded, 'c0')?.resolutionId, 'r1');
  assert.equal(provisionalAttempts(loaded).length, 1);
});

test('normalizeRecord tolerates garbage and other schema versions', () => {
  assert.equal(normalizeRecord(null, 's', 'p').schemaVersion, 1);
  assert.equal(normalizeRecord({ schemaVersion: 2 }, 's', 'p').seedId, 's');
  assert.equal(normalizeRecord({ schemaVersion: 1, actors: 'nope', inspector: 5 }, 's', 'p').inspector.length, 0);
});

test('M1-11 / M1-12: a bind whose pending attempt or epoch does not match is ignored; a stale prepared resolution is invalidated', () => {
  const prepared = run(newRecord('seed', 'p1'), [
    { type: 'set_baseline', cursor: 'c0', state: emptyState(), reason: 'test' },
    { type: 'prepare', resolution: resolution('r1'), action: action(), attemptId: 'a1', actorId: 'oren', epoch: 1, composerText: 'x', now: 1 },
  ]).record;
  assert.equal(applyEvent(prepared, { type: 'bind', attemptId: 'a1', cursorBefore: 'c0', epoch: 2, injectedText: '' }).changed, false);
  assert.equal(applyEvent(prepared, { type: 'bind', attemptId: 'zz', cursorBefore: 'c0', epoch: 1, injectedText: '' }).changed, false);
  const invalidated = run(prepared, [{ type: 'invalidate_prepared', reason: 'profile changed', onlyUnbound: true, profileRevision: 'p2' }]).record;
  assert.equal(invalidated.resolutions.r1!.status, 'invalidated');
  assert.equal(invalidated.pending, null);
  assert.equal(invalidated.attempts.a1!.status, 'cancelled');
  assert.equal(invalidated.profileRevision, 'p2');
});

test('M3-08 / wording_swipes vector: five wording regenerations reuse one resolution and never re-assess', () => {
  const v = vector('wording_swipes');
  assert.ok(v);
  let r = sendToProvisional().record;
  for (let i = 0; i < 5; i++) {
    const active = activeResolutionForCursor(r, 'c0');
    assert.equal(active?.resolutionId, 'r1');
    r = run(r, [
      { type: 'regeneration_attempt', attemptId: `sw${i}`, resolutionId: active!.resolutionId, cursorBefore: 'c0', epoch: 1, generationType: 'swipe', actorId: 'oren', injectedText: 'block', unadjudicated: false, now: 10 + i },
      { type: 'completed', attemptId: `sw${i}`, epoch: 1, operationId: `op-sw${i}`, variantId: `vsw${i}`, hostMessageRef: 3, hostVariantRef: i + 1, cursorAfter: `c1-${i}`, now: 11 + i },
    ]).record;
  }
  assert.equal(Object.keys(r.resolutions).length, v.expected.resolutionCount);
  assert.equal(r.resolutions.r1!.outcome, v.expected.outcome);
  assert.equal(Object.values(r.variants).filter(x => x.resolutionId === 'r1').length, 6);
});

test('M3-09 / explicit_reroll vector: reroll links a new resolution, old variant stays restorable, same result allowed (M3-12)', () => {
  const v = vector('explicit_reroll');
  assert.ok(v);
  const { record } = sendToProvisional();
  const rerolled = run(record, [{ type: 'reroll', previousResolutionId: 'r1', resolution: resolution('r2', 'deferred'), now: 5 }]).record;
  assert.equal(Object.keys(rerolled.resolutions).length, v.expected.resolutionCount);
  assert.equal(rerolled.resolutions.r2!.previousResolutionId, v.expected.newPreviousResolutionId);
  assert.equal(rerolled.resolutions.r2!.cursorBefore, 'c0');
  assert.equal(rerolled.resolutions.r2!.generation, 2);
  assert.equal(rerolled.resolutions.r1!.status, 'superseded');
  assert.equal(activeResolutionForCursor(rerolled, 'c0')?.resolutionId, 'r2');
  assert.equal(rerolled.resolutions.r2!.outcome, 'deferred', 'M3-12: an honest unchanged result is allowed');
  assert.equal(rerolled.variants.v1!.resolutionId, 'r1', 'old variant keeps its link');
  const back = run(rerolled, [{ type: 'select_variant', variantId: 'v1', cursorAfter: 'c1', chain: ['c0', 'c1'] }]).record;
  assert.equal(back.projection.status, 'provisional');
});

test('M3-10: a changed action creates a new action identity and leaves accepted history unchanged', () => {
  const accepted = run(sendToProvisional('deferred').record, [{ type: 'accept', attemptId: 'a1', operationId: 'acc', now: 3 }]).record;
  const changed = run(accepted, [
    { type: 'prepare', resolution: resolution('r2', 'achieved', null, action('act2')), action: action('act2'), attemptId: 'a2', actorId: 'oren', epoch: 1, composerText: 'here is my permit', now: 4 },
  ]).record;
  assert.equal(Object.keys(changed.actions).length, 2);
  assert.equal(changed.resolutions.r1!.status, 'accepted');
  assert.equal(changed.resolutions.r2!.actionId, 'act2');
});

test('M3-11: a profile revision change invalidates only unused preparation; accepted swipes keep their policy', () => {
  const accepted = run(sendToProvisional('deferred').record, [{ type: 'accept', attemptId: 'a1', operationId: 'acc', now: 3 }]).record;
  const withPrepared = run(accepted, [{ type: 'reroll', previousResolutionId: 'r1', resolution: resolution('r2'), now: 4 }]).record;
  const out = run(withPrepared, [{ type: 'invalidate_prepared', reason: 'policy edited', onlyUnbound: false, profileRevision: 'p2' }]).record;
  assert.equal(out.resolutions.r1!.status, 'accepted');
  assert.equal(out.resolutions.r1!.policyRevision, 'p1');
  assert.equal(out.resolutions.r2!.status, 'invalidated');
});

test('no_erasure vector / M3-07: a deferred acceptance never erases an established gain', () => {
  const v = vector('no_erasure');
  assert.ok(v);
  const seeded = emptyState();
  seeded.variables.earnedPermit = true;
  const base = run(newRecord('seed', 'p1'), [{ type: 'set_baseline', cursor: 'c0', state: seeded, reason: 'test' }]).record;
  const out = run(base, [
    { type: 'prepare', resolution: resolution('r1', 'deferred'), action: action(), attemptId: 'a1', actorId: 'oren', epoch: 1, composerText: '', now: 1 },
    { type: 'bind', attemptId: 'a1', cursorBefore: 'c0', epoch: 1, injectedText: 'b' },
    { type: 'completed', attemptId: 'a1', epoch: 1, operationId: 'op', variantId: 'v1', hostMessageRef: 1, hostVariantRef: 0, cursorAfter: 'c1', now: 2 },
    { type: 'accept', attemptId: 'a1', operationId: 'acc', now: 3 },
  ]).record;
  assert.equal(out.projection.state.variables.earnedPermit, v.expected.earnedPermit);
  assert.equal(out.projection.state.variables['gain:act1'], undefined);
});

test('M3-14: a provisional reply cannot yield accepted effects until accepted; wording retry reuses deferred', () => {
  const { record } = sendToProvisional('deferred');
  assert.equal(record.projection.status, 'provisional');
  assert.deepEqual(record.projection.state.acceptedResolutionIds, []);
  const retry = run(record, [
    { type: 'reject', attemptId: 'a1' },
    { type: 'regeneration_attempt', attemptId: 'a2', resolutionId: activeResolutionForCursor(record, 'c0')!.resolutionId, cursorBefore: 'c0', epoch: 1, generationType: 'swipe', actorId: 'oren', injectedText: 'b', unadjudicated: false, now: 4 },
  ]).record;
  assert.equal(retry.attempts.a2!.resolutionId, 'r1');
  assert.equal(retry.resolutions.r1!.outcome, 'deferred');
});

test('a user message between the last checkpoint and the generation extends the chain without changing state', () => {
  const seeded = emptyState();
  seeded.variables.trust = 2;
  const base = run(newRecord('seed', 'p1'), [{ type: 'set_baseline', cursor: 'c0', state: seeded, reason: 'test' }]).record;
  const extended = run(base, [{ type: 'extend_checkpoint', cursor: 'c0u', parentCursor: 'c0' }]).record;
  assert.equal(extended.checkpoints.c0u!.parentCursor, 'c0');
  assert.equal(extended.checkpoints.c0u!.stateAfter.variables.trust, 2);
  assert.equal(extended.projection.cursor, 'c0u');
  assert.equal(extended.projection.status, 'current');
  const out = run(extended, [
    { type: 'prepare', resolution: null, action: null, attemptId: 'a1', actorId: 'mira', epoch: 1, composerText: 'hi', now: 1 },
    { type: 'bind', attemptId: 'a1', cursorBefore: 'c0u', epoch: 1, injectedText: '' },
    { type: 'completed', attemptId: 'a1', epoch: 1, operationId: 'op', variantId: 'v1', hostMessageRef: 1, hostVariantRef: 0, cursorAfter: 'c1', now: 2 },
  ]).record;
  assert.equal(out.projection.status, 'current', 'predecessor is known through the extended checkpoint');
  assert.equal(out.projection.state.variables.trust, 2);
  assert.equal(applyEvent(extended, { type: 'extend_checkpoint', cursor: 'cX', parentCursor: 'nope' }).changed, false);
});

test('speaker-only turns without a resolution auto-accept and checkpoint', () => {
  const base = run(newRecord('seed', 'p1'), [{ type: 'set_baseline', cursor: 'c0', state: emptyState(), reason: 'test' }]).record;
  const out = run(base, [
    { type: 'prepare', resolution: null, action: null, attemptId: 'a1', actorId: 'mira', epoch: 1, composerText: '', now: 1 },
    { type: 'bind', attemptId: 'a1', cursorBefore: 'c0', epoch: 1, injectedText: '' },
    { type: 'completed', attemptId: 'a1', epoch: 1, operationId: 'op', variantId: 'v1', hostMessageRef: 1, hostVariantRef: 0, cursorAfter: 'c1', now: 2 },
  ]).record;
  assert.equal(out.attempts.a1!.status, 'accepted');
  assert.equal(out.variants.v1!.acceptance, 'auto');
  assert.equal(out.projection.status, 'current');
  assert.equal(out.checkpoints.c1!.variantId, 'v1');
});

test('manual scene boundary advances at the head and rewinding restores an earlier scene checkpoint', () => {
  const base = run(newRecord('seed', 'p1'), [{ type: 'set_baseline', cursor: 'c0', state: emptyState(), reason: 'test' }]).record;
  const replied = run(base, [
    { type: 'prepare', resolution: null, action: null, attemptId: 'a1', actorId: 'mira', epoch: 1, composerText: '', now: 1 },
    { type: 'bind', attemptId: 'a1', cursorBefore: 'c0', epoch: 1, injectedText: '' },
    { type: 'completed', attemptId: 'a1', epoch: 1, operationId: 'op', variantId: 'v1', hostMessageRef: 1, hostVariantRef: 0, cursorAfter: 'c1', now: 2 },
  ]).record;
  const nextScene = applyEvent(replied, { type: 'start_scene', cursor: 'c1', reason: 'user' }).record;
  assert.equal(nextScene.projection.state.sceneId, 2);
  assert.equal(nextScene.projection.state.sceneReplyCount, 0);
  const rewound = applyEvent(nextScene, { type: 'head_changed', cursor: 'c0', chain: ['c0'], reason: 'branch' }).record;
  assert.equal(rewound.projection.state.sceneId, 1);
});

test('accepted final rulings store their frozen meaning independently of later policy tables', () => {
  const act: ActionSpec = {
    actionId: 'a-persist', identityVersion: 2, templateId: 'acquire_secure', actingActorId: 'player', playerActorId: 'player', targetActorIds: ['oren'],
    attemptedAction: 'asks for the key', requestedGain: 'Dom controls the gate key', applicability: 'favorable', uncertainConsequential: true, opposed: true,
    resolutionScope: 'persistent', sceneId: 1, persistentFactKey: 'gate-key-control', failureStake: { kind: 'closed_opportunity', detail: 'Oren refuses this route' }, availableEvidence: '', preconditions: [],
  };
  const res = freeze({
    resolutionId: 'rf', previousResolutionId: null, action: act,
    snapshot: { chatId: 'c', cursorBefore: 'c0', stateRevision: 0, scopeId: 'shared-public', profileRevision: 'p1', catalogRevision: '', actorBindingRevision: '', state: {} },
    assessment: null, decisionSource: 'provider', policyRevision: 'old-table', band: null, method: 'threshold', draw: null, outcome: 'shut_out',
    def: { name: 'shut_out', instruction: 'The route closes.', records: 'failed', final: true }, cursorBefore: null, generation: 1, providerKind: 'mock', requestedModel: null, returnedModel: null, now: 1,
  });
  const provisional = run(newRecord('seed', 'p1'), [
    { type: 'set_baseline', cursor: 'c0', state: emptyState(), reason: 'test' },
    { type: 'prepare', resolution: res, action: act, attemptId: 'a1', actorId: 'oren', epoch: 1, composerText: '', now: 1 },
    { type: 'bind', attemptId: 'a1', cursorBefore: 'c0', epoch: 1, injectedText: 'block' },
    { type: 'completed', attemptId: 'a1', epoch: 1, operationId: 'op', variantId: 'v1', hostMessageRef: 1, hostVariantRef: 0, cursorAfter: 'c1', now: 2 },
  ]).record;
  const accepted = applyEvent(provisional, { type: 'accept', attemptId: 'a1', operationId: 'accept', now: 3 }).record;
  const frozen = accepted.projection.state.settledGains[gainVariableId(act)]!;
  assert.deepEqual(frozen.outcome, { name: 'shut_out', instruction: 'The route closes.', records: 'failed', final: true });
  const reloaded = normalizeRecord(accepted, 'seed', 'new-profile');
  assert.equal(reloaded.projection.state.settledGains[gainVariableId(act)]!.outcome.name, 'shut_out');
});

test('native bypass generations are recorded as unadjudicated and never labelled binding', () => {
  const base = run(newRecord('seed', 'p1'), [{ type: 'set_baseline', cursor: 'c0', state: emptyState(), reason: 'test' }]).record;
  const out = run(base, [
    { type: 'regeneration_attempt', attemptId: 'n1', resolutionId: null, cursorBefore: 'c0', epoch: 1, generationType: 'normal', actorId: null, injectedText: '', unadjudicated: true, now: 1 },
    { type: 'completed', attemptId: 'n1', epoch: 1, operationId: 'op', variantId: 'v1', hostMessageRef: 1, hostVariantRef: 0, cursorAfter: 'c1', now: 2 },
  ]);
  assert.equal(out.record.attempts.n1!.unadjudicated, true);
  assert.equal(out.record.attempts.n1!.resolutionId, null);
  assert.ok(out.notices.some(n => /unadjudicated/.test(n)));
});

test('bind to a different prefix than the frozen one invalidates that resolution instead of misapplying it', () => {
  const base = run(newRecord('seed', 'p1'), [
    { type: 'set_baseline', cursor: 'c0', state: emptyState(), reason: 'test' },
    { type: 'prepare', resolution: resolution('r1', 'deferred', 'c-other'), action: action(), attemptId: 'a1', actorId: 'oren', epoch: 1, composerText: '', now: 1 },
  ]).record;
  const out = run(base, [{ type: 'bind', attemptId: 'a1', cursorBefore: 'c0', epoch: 1, injectedText: '' }]);
  assert.equal(out.record.resolutions.r1!.status, 'invalidated');
  assert.equal(out.record.attempts.a1!.resolutionId, null);
  assert.equal(out.record.attempts.a1!.unadjudicated, true);
});

test('inspector entries are bounded', () => {
  let r = newRecord('s', 'p');
  for (let i = 0; i < 205; i++) {
    r = applyEvent(r, { type: 'inspect', entry: { id: String(i), at: i, epoch: 1, kind: 'info', attemptId: null, resolutionId: null, actionId: null, applicability: null, questions: null, stateSent: null, answers: null, speaker: null, policyBandId: null, draw: null, outcome: null, injectedText: null, providerKind: null, requestedModel: null, returnedModel: null, durationMs: null, inputTokens: null, outputTokens: null, networkCalls: 0, message: 'x' } }).record;
  }
  assert.equal(r.inspector.length, 200);
  assert.equal(r.inspector[0]!.id, '5');
});
