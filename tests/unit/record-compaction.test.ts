import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyStory, HISTORY_LIMIT, snapshotAt, withSnapshot } from '../../src/story.ts';
import { compactRecord, needsLegacyRecordBackup, newRecord, normalizeRecord } from '../../src/state.ts';
import { encodeRecordForStorage } from '../../src/state-storage.ts';
import type { DirectorChatRecord, FrozenResolution, GenerationAttempt } from '../../src/types.ts';

test('T16: wording variants share snapshots without evicting recent judged turns', () => {
  let story = emptyStory();
  for (let i = 0; i < 3; i++) story = withSnapshot(story, `turn${i}`, { at: i, meters: { npc: { resolve: i } }, knownBy: {} });
  const frozen = structuredClone(story.history.turn2!);
  for (let i = 0; i < HISTORY_LIMIT + 20; i++) story = withSnapshot(story, `swipe${i}`, structuredClone(frozen));
  assert.equal(Object.keys(story.history).length, 3, 'wording swipes share their turn snapshot');
  assert.equal(snapshotAt(story, ['turn0'])?.meters.npc!.resolve, 0);
  assert.equal(snapshotAt(story, ['turn1'])?.meters.npc!.resolve, 1);
  for (let i = 0; i < HISTORY_LIMIT + 20; i++) assert.deepEqual(snapshotAt(story, [`swipe${i}`]), frozen);
});

function attempt(id: string, cursor: string, at: number): GenerationAttempt {
  return { attemptId: id, resolutionId: `r-${id}`, actorId: 'npc', cursorBefore: cursor, status: 'accepted', generationType: 'normal',
    hostMessageRef: at, hostVariantRef: 0, variantId: `v-${id}`, injectedText: 'frozen direction', epoch: 1, unadjudicated: false, createdAt: at };
}

function addTurn(record: DirectorChatRecord, id: string, cursor: string, at: number): void {
  const a = attempt(id, cursor, at);
  record.attempts[id] = a;
  const action = { actionId: `action-${id}`, templateId: 'obtain_access', playerActorId: 'player', targetActorIds: ['npc'], attemptedAction: 'asks for access', requestedGain: 'access', applicability: 'favorable' as const, preconditions: [] };
  record.actions[action.actionId] = action;
  record.resolutions[`r-${id}`] = { resolutionId: `r-${id}`, previousResolutionId: null, actionId: action.actionId, action,
    snapshot: { chatId: 'chat', cursorBefore: cursor, stateRevision: 0, scopeId: 'public', profileRevision: 'p', catalogRevision: '', actorBindingRevision: '', state: { transcript: 'evidence '.repeat(800) } },
    assessment: null, decisionSource: 'rules', policyRevision: 'p', policyBand: null, method: 'sample', draw: 0.25, outcome: 'progress', status: 'accepted',
    cursorBefore: cursor, generation: 1, providerKind: null, requestedModel: null, returnedModel: null, createdAt: at } satisfies FrozenResolution;
  record.variants[`v-${id}`] = { variantId: `v-${id}`, attemptId: id, resolutionId: `r-${id}`, actorId: 'npc', cursorBefore: cursor, cursorAfter: `after-${id}` };
  record.story.history[`after-${id}`] = { at, meters: { npc: { resolve: at % 4 } }, knownBy: {} };
  record.story.lore[cursor] = { at, refs: [], requests: 0, books: [], failed: [] };
}

test('34: compaction preserves live and unselected swipes, pending work, and a failed writer with no reply marker', () => {
  const record = newRecord('seed', 'p');
  for (const [i, id] of ['live', 'unselected', 'deleted-swipe', 'retry', 'pending', 'dead'].entries()) addTurn(record, id, id === 'deleted-swipe' ? 'live-input' : `${id}-input`, i);
  record.attempts.live!.cursorBefore = 'live-input';
  record.attempts.retry!.status = 'failed';
  record.attempts.pending!.status = 'prepared';
  record.pending = { attemptId: 'pending', resolutionId: 'r-pending', actorId: 'npc', epoch: 1, composerText: 'next', createdAt: 4 };
  record.appliedOperationIds = Array.from({ length: 800 }, (_, i) => `op${i}`);
  const original = structuredClone(record);
  const compacted = compactRecord(record, { liveCursors: ['root', 'live-input', 'after-live', 'retry-input'], liveVariantIds: ['v-live', 'v-unselected'] });
  assert.deepEqual(Object.keys(compacted.variants).sort(), ['v-live', 'v-unselected']);
  assert.deepEqual(Object.keys(compacted.attempts).sort(), ['dead', 'deleted-swipe', 'live', 'pending', 'retry', 'unselected']);
  assert.deepEqual(compacted.resolutions['r-retry'], record.resolutions['r-retry'], 'failed writer keeps the exact frozen draw');
  assert.equal(compacted.attempts.retry!.variantId, null);
  assert.equal(compacted.attempts.retry!.hostMessageRef, null);
  assert.deepEqual(compacted.resolutions['r-dead'], record.resolutions['r-dead'], 'a recent off-chain ruling survives edit/revert');
  assert.deepEqual(compacted.actions['action-dead'], record.actions['action-dead']);
  assert.equal(compacted.story.history['after-dead'], undefined);
  assert.deepEqual(compacted.story.lore['dead-input'], record.story.lore['dead-input']);
  assert.equal(compacted.appliedOperationIds.length, 200);
  assert.deepEqual(record, original, 'compaction never mutates its input');
  assert.deepEqual(compactRecord(compacted, { liveCursors: ['root', 'live-input', 'after-live', 'retry-input'], liveVariantIds: ['v-live', 'v-unselected'] }), compacted, 'compaction is idempotent');
});

test('34: a pending explicit reroll preserves newly frozen resolution and permit IDs', () => {
  const record = newRecord('seed', 'p');
  addTurn(record, 'old', 'input', 1);
  addTurn(record, 'reroll', 'input', 2);
  delete record.attempts.reroll;
  const compacted = compactRecord(record, { liveCursors: ['input'], liveVariantIds: ['v-old'], activeResolutionIds: ['r-reroll'] });
  assert.deepEqual(compacted.resolutions['r-reroll'], record.resolutions['r-reroll']);
  assert.equal(compacted.variants['v-reroll'], undefined);
});

test('34: only retryable failures keep stage replay, without duplicated judge transcripts', () => {
  const record = newRecord('seed', 'p');
  addTurn(record, 'success', 'success-input', 1);
  addTurn(record, 'failure', 'failure-input', 2);
  const replay: NonNullable<GenerationAttempt['stageRecords']> = [{ stage: 'move', questions: {}, state: { transcript: 'private '.repeat(500) },
    result: { requestId: 'request', provider: 'mock', requestedModel: null, returnedModel: null, answers: {}, errors: {}, unresolvedQuestionIds: [],
      inputTokens: null, outputTokens: null, durationMs: 0, transportAttempts: 0 } }];
  record.attempts.success!.stageRecords = structuredClone(replay);
  record.attempts.success!.judgeFailedStages = ['lore'];
  record.attempts.failure!.stageRecords = structuredClone(replay);
  record.attempts.failure!.judgeFailedStages = ['ruling'];
  const compacted = compactRecord(record, { liveCursors: ['success-input', 'failure-input'], liveVariantIds: ['v-success', 'v-failure'] });
  assert.equal(compacted.attempts.success!.stageRecords, undefined);
  assert.equal(compacted.attempts.failure!.stageRecords?.[0]!.state, null);
  assert.deepEqual(compacted.attempts.failure!.stageRecords?.[0]!.questions, replay[0]!.questions);
  assert.deepEqual(compacted.attempts.failure!.stageRecords?.[0]!.result, replay[0]!.result);
  assert.deepEqual(compacted.resolutions, record.resolutions, 'ruling evidence is still immutable');
});

test('23/34: aliases survive reload and compaction when their original wording was deleted', () => {
  let record = newRecord('seed', 'p');
  const snap = { at: 1, meters: { npc: { resolve: 2 } }, knownBy: {} };
  record.story = withSnapshot(record.story, 'deleted-wording', snap);
  record.story = withSnapshot(record.story, 'current-wording', structuredClone(snap));
  record = normalizeRecord(JSON.parse(JSON.stringify(record)), 'seed', 'p');
  record = compactRecord(record, { liveCursors: ['root', 'current-wording'], liveVariantIds: [] });
  assert.deepEqual(snapshotAt(record.story, ['current-wording']), snap);
  assert.equal(Object.keys(record.story.history).length, 1);
});

test('23: replacing a canonical snapshot cannot change another wording snapshot', () => {
  const old = { at: 1, meters: { npc: { resolve: 1 } }, knownBy: {} };
  let story = withSnapshot(emptyStory(), 'a', old);
  story = withSnapshot(story, 'b', structuredClone(old));
  story = withSnapshot(story, 'c', structuredClone(old));
  story = withSnapshot(story, 'a', { at: 2, meters: { npc: { resolve: 2 } }, knownBy: {} });
  assert.deepEqual(snapshotAt(story, ['b']), old);
  assert.deepEqual(snapshotAt(story, ['c']), old);
  assert.equal(snapshotAt(story, ['a'])?.meters.npc!.resolve, 2);
});

test('23/34: existing duplicate wording snapshots compact without losing either live cursor', () => {
  const record = newRecord('seed', 'p');
  const snap = { at: 1, meters: { npc: { resolve: 2 } }, knownBy: {} };
  record.story.history = { first: structuredClone(snap), second: structuredClone(snap) };
  const compacted = compactRecord(record, { liveCursors: ['first', 'second'], liveVariantIds: [] });
  assert.equal(Object.keys(compacted.story.history).length, 1);
  assert.deepEqual(snapshotAt(compacted.story, ['first']), snap);
  assert.deepEqual(snapshotAt(compacted.story, ['second']), snap);
});

test('25: raw legacy records need a rollback copy only before their first normalization', () => {
  const legacy = { schemaVersion: 1, projection: { observer: 'historical data' } };
  assert.equal(needsLegacyRecordBackup(legacy), true);
  assert.equal(needsLegacyRecordBackup(normalizeRecord(legacy, 'seed', 'p')), false);
  assert.equal(needsLegacyRecordBackup(newRecord('seed', 'p')), false);
  for (const invalid of [null, [], {}, { schemaVersion: 2 }]) assert.equal(needsLegacyRecordBackup(invalid), false);
});

test('33: lore reuse retains its public evidence partition and configuration through reload', () => {
  const record = newRecord('seed', 'p');
  record.story.lore.input = { at: 1, refs: [{ world: 'Private book', uid: 1, title: 'A private note', score: 1 }],
    evidenceRefs: [{ world: 'Public book', uid: 2, title: 'A public note', score: 1 }], scene: { text: 'At the gate.' },
    configuration: 'configuration-fingerprint', requests: 1, books: ['Private book', 'Public book'], failed: [] };
  const loaded = normalizeRecord(JSON.parse(JSON.stringify(record)), 'seed', 'p');
  assert.deepEqual(loaded.story.lore.input, record.story.lore.input);
});

test('34: synthetic large record shrinks while recent replay and every surviving frozen ruling stay intact', t => {
  const record = newRecord('seed', 'p');
  for (let i = 0; i < 100; i++) addTurn(record, `turn${i}`, `input${i}`, i);
  const copy = JSON.parse(JSON.stringify(record)) as DirectorChatRecord;
  const live = { liveCursors: ['root', 'input0', 'after-turn0', 'input1', 'after-turn1'], liveVariantIds: ['v-turn0', 'v-turn1'] };
  const compacted = compactRecord(copy, live);
  const before = Buffer.byteLength(JSON.stringify(copy));
  const after = Buffer.byteLength(JSON.stringify(encodeRecordForStorage(compacted)));
  assert.ok(after < before / 10);
  for (const id of ['r-turn0', 'r-turn1']) {
    assert.equal(compacted.resolutions[id]?.draw, copy.resolutions[id]?.draw);
    assert.deepEqual(compacted.resolutions[id]?.action, copy.resolutions[id]?.action);
    assert.equal(compacted.resolutions[id]?.snapshot.state, null, 'old replay evidence is trimmed');
  }
  assert.deepEqual(compacted.resolutions['r-turn99'], copy.resolutions['r-turn99'], 'recent off-chain replay survives');
  t.diagnostic(`Synthetic read-only copy: ${before} bytes -> ${after} bytes; ${Object.keys(copy.attempts).length} attempts -> ${Object.keys(compacted.attempts).length}.`);
});
