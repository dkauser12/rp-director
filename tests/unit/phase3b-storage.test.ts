import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeRecordStorage, encodeRecordForStorage } from '../../src/state-storage.ts';
import { compactRecord, newRecord, normalizeRecord, replayIsTrimmed } from '../../src/state.ts';
import type { GenerationAttempt, TurnPermit } from '../../src/types.ts';

function populated() {
  const record = newRecord('seed', 'profile');
  for (let i = 0; i < 25; i++) {
    const attempt = {
      attemptId: `attempt${i}`, resolutionId: null, permitId: `permit${i}`, actorId: 'npc', cursorBefore: `cursor${i}`,
      status: 'accepted', generationType: 'normal', hostMessageRef: i * 2 + 1, hostVariantRef: 0,
      variantId: `variant${i}`, injectedText: `A repeated exact header that describes the frozen scene.\nTurn ${i}.\nA repeated exact closing instruction that must stay byte-identical.\n`,
      epoch: 0, unadjudicated: false, createdAt: i,
    } satisfies GenerationAttempt;
    record.attempts[attempt.attemptId] = attempt;
    record.variants[`variant${i}`] = { variantId: `variant${i}`, attemptId: attempt.attemptId, resolutionId: null, permitId: `permit${i}`, actorId: 'npc', cursorBefore: attempt.cursorBefore, cursorAfter: `after${i}` };
    record.permits[`permit${i}`] = { schemaVersion: 1, permitId: `permit${i}`, attemptId: attempt.attemptId,
      speakerActorId: 'npc', baseCursor: attempt.cursorBefore, stateRevision: 0, actions: [], compactState: { sceneId: 1, revision: 0 }, constraints: [], createdAt: i,
      snapshot: { chatId: 'chat', cursorBefore: attempt.cursorBefore, stateRevision: 0, scopeId: 'public', profileRevision: 'profile', catalogRevision: '', actorBindingRevision: '',
        state: { $t: [0, 'literal evidence'], nested: { $o: [['key', 'literal evidence']], $v: [0, 'literal'] }, transcript: 'Repeated evidence text. '.repeat(30) } },
    } satisfies TurnPermit;
  }
  return record;
}

test('storage sharing roundtrips exact text, literal reserved keys, and records without mutation', () => {
  const record = populated();
  const before = structuredClone(record);
  const stored = JSON.parse(JSON.stringify(encodeRecordForStorage(record)));
  assert.deepEqual(decodeRecordStorage(stored), record);
  assert.deepEqual(normalizeRecord(stored, 'other-seed', 'other-profile'), record);
  assert.deepEqual(record, before);
  assert.ok(JSON.stringify(stored).length < JSON.stringify(record).length);
});

test('shared object shapes preserve JSON omission of undefined story baselines', () => {
  const record = populated();
  for (const attempt of Object.values(record.attempts)) {
    attempt.storyBefore = undefined;
    attempt.storyAfter = undefined;
    attempt.frozenStateBlock = undefined;
  }
  const expected = JSON.parse(JSON.stringify(record));
  const stored = JSON.parse(JSON.stringify(encodeRecordForStorage(record)));
  const decoded = decodeRecordStorage(stored);
  assert.deepEqual(decoded, expected);
  const loaded = normalizeRecord(stored, 'seed', 'profile');
  assert.equal(Object.hasOwn(loaded.attempts.attempt0!, 'storyBefore'), false);
  assert.equal(Object.hasOwn(loaded.attempts.attempt0!, 'storyAfter'), false);
});

test('old replay is unavailable while kept permits and the last twenty off-chain rulings remain exact', () => {
  const record = populated();
  const compacted = compactRecord(record, { liveCursors: Object.values(record.attempts).map(attempt => attempt.cursorBefore!), liveVariantIds: Object.keys(record.variants) });
  assert.equal(replayIsTrimmed(compacted, compacted.attempts.attempt0!), true);
  assert.equal(compacted.permits.permit0!.snapshot, undefined);
  assert.deepEqual(compacted.permits.permit0!.actions, record.permits.permit0!.actions);
  assert.equal(replayIsTrimmed(compacted, compacted.attempts.attempt24!), false);
  assert.deepEqual(compacted.permits.permit24, record.permits.permit24);
  const detached = compactRecord(record, { liveCursors: [], liveVariantIds: [] });
  assert.equal(Object.keys(detached.attempts).length, 20);
  assert.equal(detached.attempts.attempt0, undefined);
  assert.deepEqual(detached.permits.permit24, record.permits.permit24);
});

test('plain and malformed storage metadata remains safe to normalize', () => {
  const plain = newRecord('seed', 'profile');
  assert.deepEqual(decodeRecordStorage(plain), plain);
  for (const sharedStorage of [null, {}, { version: 1, strings: [null] }, { version: 2, strings: [] }]) {
    assert.doesNotThrow(() => normalizeRecord({ ...plain, sharedStorage }, 'seed', 'profile'));
  }
});

test('a wording swipe cannot move an old turn into the recent replay window', () => {
  const record = populated();
  record.attempts.wording = { ...record.attempts.attempt0!, attemptId: 'wording', createdAt: 100, variantId: null, hostMessageRef: null, hostVariantRef: null };
  record.attempts.next = { ...record.attempts.attempt24!, attemptId: 'next', cursorBefore: 'next-beat', turnKind: 'director_next', createdAt: 26, variantId: null, hostMessageRef: null, hostVariantRef: null };
  const compacted = compactRecord(record, { liveCursors: Object.values(record.attempts).map(attempt => attempt.cursorBefore!), liveVariantIds: Object.keys(record.variants) });
  assert.equal(replayIsTrimmed(compacted, compacted.attempts.wording!), true);
  assert.equal(replayIsTrimmed(compacted, compacted.attempts.attempt5!), false, 'a Next beat does not evict the twentieth user turn');
  assert.deepEqual(compacted.permits.permit5, record.permits.permit5);
});

test('damaged shared prose is omitted without dropping its frozen turn or permit', () => {
  for (const broken of [{ $t: [999999] }, { $t: [-1] }, { $t: 'bad' }, { $v: 'bad' }, { $o: 'bad' }, { $v: [999999, 'bad'] }, { $v: [0, 'wrong shape length'] }]) {
    const record = populated();
    const attempt = record.attempts.attempt24!;
    const raw = { ...record, attempts: { ...record.attempts, attempt24: { ...attempt, frozenStateBlock: broken, injectedText: broken } },
      sharedStorage: { version: 1, strings: [], shapes: [['first', 'second']], actions: {} } };
    const loaded = normalizeRecord(raw, 'seed', 'profile');
    assert.equal(loaded.attempts.attempt24!.frozenStateBlock, undefined);
    assert.equal(loaded.attempts.attempt24!.injectedText, '');
    assert.equal(loaded.attempts.attempt24!.permitId, attempt.permitId);
    assert.deepEqual(loaded.permits.permit24, record.permits.permit24);
  }
});

test('a damaged encoded root normalizes safely', () => {
  for (const broken of [{ $v: [999999] }, { $t: 'bad' }, { $o: 'bad' }]) {
    assert.doesNotThrow(() => normalizeRecord({ ...broken, sharedStorage: { version: 1, strings: [], shapes: [], actions: {} } }, 'seed', 'profile'));
  }
});
