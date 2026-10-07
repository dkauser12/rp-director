import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newRecord, normalizeRecord, applyEvent, activeResolutionForCursor, attemptForVariant, resolutionsForAction } from '../../src/state.ts';
import type { DirectorEvent } from '../../src/state.ts';
import { freeze } from '../../src/resolver.ts';
import type { ActionSpec, DirectorChatRecord, FrozenResolution, Outcome, SpeakerDecision, StorySnapshot } from '../../src/types.ts';

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

function prepare(record = newRecord('seed', 'p1')) {
  return applyEvent(record, {
    type: 'prepare', resolution: resolution('r1'), action: action(), attemptId: 'a1', actorId: 'oren',
    epoch: 1, composerText: 'let me through', now: 1,
  }).record;
}
const completion: DirectorEvent = { type: 'completed', attemptId: 'a1', epoch: 1, operationId: 'op-a1', variantId: 'v1', hostMessageRef: 3, hostVariantRef: 0, cursorAfter: 'c1', now: 2 };
function completed() {
  return run(prepare(), [
    { type: 'bind', attemptId: 'a1', cursorBefore: 'c0', epoch: 1, injectedText: 'block' }, completion,
  ]).record;
}

test('W6: completion is final immediately, without observer, baseline, checkpoint, or commit', () => {
  const record = completed();
  assert.equal(record.attempts.a1!.status, 'accepted');
  assert.equal('acceptance' in record.variants.v1!, false);
  assert.equal(record.resolutions.r1!.status, 'accepted');
  assert.equal(record.resolutions.r1!.cursorBefore, 'c0');
  for (const key of ['projection', 'checkpoints']) assert.equal(key in record, false);
  for (const key of ['observation', 'observerStatus', 'observerError']) assert.equal(key in record.variants.v1!, false);
  assert.deepEqual(applyEvent(record, completion).record, record, 'duplicate completion has no effect');
});

test('W1/W6: a next turn prepares immediately after a ruled reply', () => {
  const record = completed();
  const next = applyEvent(record, { type: 'prepare', resolution: null, action: null, attemptId: 'a2', actorId: null, epoch: 1, composerText: 'again', now: 3 }).record;
  assert.equal(next.pending?.attemptId, 'a2');
  assert.equal(next.attempts.a2!.status, 'prepared');
  assert.equal(next.attempts.a1!.status, 'accepted');
});

test('W3: repeated wording swipes share a single frozen ruling', () => {
  let record = completed();
  for (let index = 1; index <= 5; index++) {
    const active = activeResolutionForCursor(record, 'c0')!;
    record = run(record, [
      { type: 'regeneration_attempt', attemptId: `sw${index}`, resolutionId: active.resolutionId, cursorBefore: 'c0', epoch: 1, generationType: 'swipe', actorId: 'oren', injectedText: 'block', unadjudicated: false, now: index + 2 },
      { type: 'completed', attemptId: `sw${index}`, epoch: 1, operationId: `op-sw${index}`, variantId: `vsw${index}`, hostMessageRef: 3, hostVariantRef: index, cursorAfter: `c1-${index}`, now: index + 3 },
    ]).record;
  }
  assert.equal(Object.keys(record.resolutions).length, 1);
  assert.equal(Object.values(record.variants).filter(v => v.resolutionId === 'r1').length, 6);
  assert.equal(record.resolutions.r1!.outcome, 'deferred');
});

test('W3: attempt freezes speaker, state, errors and lore independently of later inputs', () => {
  const frozenSpeaker: SpeakerDecision = { questionId: null, eligibleActorIds: ['oren'], raw: null, adjusted: null, selected: 'oren', source: 'single', tieBroken: false };
  const judgeErrors = ['timeout'];
  const event: DirectorEvent = { type: 'prepare', resolution: null, action: null, attemptId: 'a1', actorId: 'oren', epoch: 1, composerText: 'hi', now: 1, frozenSpeaker, frozenStateBlock: 'guarded', frozenLorePlan: { force: ['Keep.1'], managed: ['Keep'] }, judgeErrors, loreCursor: 'c0' };
  const record = applyEvent(newRecord('s', 'p'), event).record;
  frozenSpeaker.selected = 'other'; judgeErrors.push('network');
  assert.equal(record.attempts.a1!.frozenSpeaker?.selected, 'oren');
  assert.equal(record.attempts.a1!.frozenStateBlock, 'guarded');
  assert.deepEqual(record.attempts.a1!.judgeErrors, ['timeout']);
  const original = record.attempts.a1!;
  const swipe = applyEvent(record, {
    type: 'regeneration_attempt', attemptId: 'sw', resolutionId: null, actorId: original.actorId,
    generationType: 'swipe', cursorBefore: 'c0', injectedText: original.frozenStateBlock!,
    unadjudicated: false, epoch: 1, now: 2, frozenSpeaker: original.frozenSpeaker,
    frozenStateBlock: original.frozenStateBlock, frozenLorePlan: original.frozenLorePlan, judgeErrors: original.judgeErrors, loreCursor: original.loreCursor,
  }).record;
  assert.equal(swipe.attempts.sw!.loreCursor, 'c0');
  assert.deepEqual(swipe.attempts.sw!.frozenSpeaker, original.frozenSpeaker);
  assert.deepEqual(swipe.attempts.sw!.judgeErrors, original.judgeErrors);
  assert.equal(swipe.attempts.sw!.frozenStateBlock, original.frozenStateBlock);
  assert.deepEqual(swipe.attempts.sw!.frozenLorePlan, { force: ['Keep.1'], managed: ['Keep'] });
  assert.deepEqual(normalizeRecord(JSON.parse(JSON.stringify(swipe)), 's', 'p').attempts.sw!.frozenLorePlan, swipe.attempts.sw!.frozenLorePlan);
});

test('W3: selecting or editing a transcript never rewrites frozen variant history', () => {
  const record = completed();
  for (const event of [
    { type: 'select_variant', variantId: 'v1', cursorAfter: 'c1', chain: ['c0', 'c1'] },
    { type: 'select_variant', variantId: null, cursorAfter: 'unknown', chain: [] },
    { type: 'head_changed', cursor: 'edited', chain: [], reason: 'edit' },
  ] satisfies DirectorEvent[]) assert.deepEqual(applyEvent(record, event).record, record);
  assert.equal(attemptForVariant(record, 'v1')?.attemptId, 'a1');
  assert.equal(attemptForVariant(record, 'unknown'), null);
});

test('W4: explicit reroll links a new draw while previous wording remains restorable', () => {
  const record = completed();
  const rerolled = applyEvent(record, { type: 'reroll', previousResolutionId: 'r1', resolution: { ...resolution('r2'), draw: 0.75 }, now: 3 }).record;
  assert.equal(rerolled.resolutions.r2!.previousResolutionId, 'r1');
  assert.equal(rerolled.resolutions.r2!.generation, 2);
  assert.equal(rerolled.resolutions.r2!.cursorBefore, 'c0');
  assert.equal(activeResolutionForCursor(rerolled, 'c0')?.resolutionId, 'r2');
  assert.equal(rerolled.variants.v1!.resolutionId, 'r1');
  assert.equal(rerolled.resolutions.r1!.draw, record.resolutions.r1!.draw);
  assert.deepEqual(resolutionsForAction(rerolled, 'act1').map(r => r.resolutionId), ['r1', 'r2']);
});

test('W3: settings edits invalidate only unbound preparation, never frozen history', () => {
  const bound = run(prepare(), [{ type: 'bind', attemptId: 'a1', cursorBefore: 'c0', epoch: 1, injectedText: 'block' }]).record;
  const event: DirectorEvent = { type: 'invalidate_prepared', reason: 'settings changed', onlyUnbound: false, profileRevision: 'p2' };
  const changed = applyEvent(bound, event).record;
  assert.deepEqual(changed.resolutions.r1, bound.resolutions.r1);
  const unbound = applyEvent(prepare(), event).record;
  assert.equal(unbound.resolutions.r1!.status, 'invalidated');
  assert.equal(unbound.pending, null);
  assert.equal(unbound.attempts.a1!.status, 'cancelled');
});

test('wrong-epoch binds and completions cannot alter current history', () => {
  const record = prepare();
  assert.equal(applyEvent(record, { type: 'bind', attemptId: 'a1', cursorBefore: 'c0', epoch: 2, injectedText: 'x' }).changed, false);
  const bound = applyEvent(record, { type: 'bind', attemptId: 'a1', cursorBefore: 'c0', epoch: 1, injectedText: 'x' }).record;
  assert.equal(applyEvent(bound, { ...completion, epoch: 2 }).changed, false);
  const cancelled = applyEvent(bound, { type: 'abort_epoch', epoch: 1, reason: 'changed chat' }).record;
  assert.equal(cancelled.attempts.a1!.status, 'cancelled');
  assert.equal(applyEvent(cancelled, completion).changed, false);
});

test('a mismatched bound prefix proceeds unruled and preserves the original ruling', () => {
  const record = prepare(); record.resolutions.r1!.cursorBefore = 'different';
  const bound = applyEvent(record, { type: 'bind', attemptId: 'a1', cursorBefore: 'c0', epoch: 1, injectedText: 'wrong block' }).record;
  assert.equal(bound.attempts.a1!.resolutionId, null);
  assert.equal(bound.attempts.a1!.injectedText, '');
  assert.equal(bound.attempts.a1!.unadjudicated, true);
  assert.deepEqual(bound.resolutions.r1, record.resolutions.r1);
});

test('normalization accepts only schema 1 and ignores malformed map entries', () => {
  assert.equal(normalizeRecord(null, 's', 'p').schemaVersion, 1);
  assert.equal(normalizeRecord({ schemaVersion: 2 }, 's', 'p').seedId, 's');
  const record = normalizeRecord({ schemaVersion: 1, actors: 'no', attempts: { bad: null }, variants: { bad: false }, inspector: 5 }, 's', 'p');
  assert.deepEqual(record.attempts, {}); assert.deepEqual(record.variants, {}); assert.deepEqual(record.inspector, []);
});

test('reload cancels only unfinished writer work; completed frozen turns stay usable', () => {
  const done = completed();
  assert.deepEqual(normalizeRecord(done, 'seed', 'p1'), done);
  const record = normalizeRecord(prepare(done), 'seed', 'p1');
  assert.equal(record.attempts.a1!.status, 'accepted');
  const pending = normalizeRecord(prepare(), 'seed', 'p1');
  assert.equal(pending.pending, null);
  assert.equal(pending.attempts.a1!.status, 'cancelled');
});

test('chat pause is saved per record and defaults off', () => {
  assert.equal(newRecord('s', 'p').paused, false);
  assert.equal(normalizeRecord({ ...newRecord('s', 'p'), paused: true }, 's', 'p').paused, true);
  assert.equal(normalizeRecord({ ...newRecord('s', 'p'), paused: 'yes' }, 's', 'p').paused, false);
});

test('inspector history remains bounded', () => {
  let record = newRecord('s', 'p');
  for (let i = 0; i < 205; i++) {
    record = applyEvent(record, { type: 'inspect', entry: { id: String(i), at: i, epoch: 1, kind: 'info', attemptId: null, resolutionId: null, actionId: null, applicability: null, questions: null, stateSent: null, answers: null, speaker: null, policyBandId: null, draw: null, outcome: null, injectedText: null, providerKind: null, requestedModel: null, returnedModel: null, durationMs: null, inputTokens: null, outputTokens: null, networkCalls: 0, message: 'x' } }).record;
  }
  assert.equal(record.inspector.length, 200);
  assert.equal(record.inspector[0]!.id, '5');
});


test('W3: story before/after snapshots freeze independently, survive regeneration and JSON reload', () => {
  const storyBefore: StorySnapshot = { at: 1, meters: { npc: { resolve: 1 } }, knownBy: { secret: ['npc'] } };
  const storyAfter: StorySnapshot = { at: 2, meters: { npc: { resolve: 2 } }, knownBy: { secret: ['npc', 'player'] } };
  const before = structuredClone(storyBefore);
  const after = structuredClone(storyAfter);
  const record = applyEvent(newRecord('s', 'p'), {
    type: 'prepare', resolution: null, action: null, attemptId: 'a', actorId: 'npc', epoch: 1,
    composerText: 'ask', now: 2, storyBefore, storyAfter,
  }).record;
  storyBefore.meters.npc!.resolve = 4;
  storyAfter.knownBy.secret!.push('other');
  assert.deepEqual(record.attempts.a!.storyBefore, before);
  assert.deepEqual(record.attempts.a!.storyAfter, after);
  const regenerated = applyEvent(record, {
    type: 'regeneration_attempt', attemptId: 'sw', resolutionId: null, cursorBefore: 'c0', epoch: 1,
    generationType: 'swipe', actorId: 'npc', injectedText: '', unadjudicated: false, now: 3,
    storyBefore: record.attempts.a!.storyBefore, storyAfter: record.attempts.a!.storyAfter,
  }).record;
  const loaded = normalizeRecord(JSON.parse(JSON.stringify(regenerated)), 's', 'p');
  assert.deepEqual(loaded.attempts.sw!.storyBefore, before);
  assert.deepEqual(loaded.attempts.sw!.storyAfter, after);
  assert.notEqual(regenerated.attempts.sw!.storyAfter, record.attempts.a!.storyAfter);
});

test('W3: missing historical story snapshots remain distinguishable from an explicitly empty baseline', () => {
  const historical = prepare();
  assert.equal('storyBefore' in historical.attempts.a1!, false);
  assert.equal('storyAfter' in historical.attempts.a1!, false);
  const explicit = applyEvent(newRecord('s', 'p'), {
    type: 'prepare', resolution: null, action: null, attemptId: 'a', actorId: 'npc', epoch: 1,
    composerText: 'ask', now: 2, storyBefore: null, storyAfter: null,
  }).record;
  assert.equal(explicit.attempts.a!.storyBefore, null);
  assert.equal(explicit.attempts.a!.storyAfter, null);
  const loaded = normalizeRecord(JSON.parse(JSON.stringify(explicit)), 's', 'p');
  assert.equal(loaded.attempts.a!.storyBefore, null);
  assert.equal(loaded.attempts.a!.storyAfter, null);
});
