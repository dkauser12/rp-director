import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cursorChain, extendCursor } from '../../src/identity.ts';
import type { FingerprintMessage } from '../../src/identity.ts';
import { rebaseRecordCursors } from '../../src/state-cursors.ts';
import { newRecord } from '../../src/state.ts';
import { snapshotAt } from '../../src/story.ts';
import type { GenerationAttempt } from '../../src/types.ts';

for (const hasSavedChain of [false, true]) test(`load rebases every downstream cursor and unselected alias (${hasSavedChain ? 'saved chain' : 'older index anchors'})`, () => {
  const fingerprints: FingerprintMessage[] = [
    { role: 'user', actorKey: 'persona', text: 'I ask for passage.' },
    { role: 'assistant', actorKey: 'guide.png', text: 'The guide listens.' },
    { role: 'user', actorKey: 'persona', text: 'I offer a reason.' },
    { role: 'assistant', actorKey: 'guide.png', text: 'The guide agrees.' },
  ];
  const chain = cursorChain('seed', fingerprints);
  const messages = fingerprints.map(message => ({ mes: message.text, is_user: message.role === 'user', extra: {} as Record<string, unknown>, swipe_id: 0, swipes: [message.text] }));
  messages[1]!.swipes.push('The guide considers it.');
  const record = newRecord('seed', 'profile');
  if (hasSavedChain) record.transcriptCursors = chain;
  for (const [id, index, swipe] of [['a', 1, 0], ['alternative', 1, 1], ['b', 3, 0]] as const) {
    const before = chain[index]!;
    const after = extendCursor(before, { ...fingerprints[index]!, text: messages[index]!.swipes[swipe]! });
    record.attempts[id] = { attemptId: id, resolutionId: null, cursorBefore: before, actorId: 'guide',
      status: 'accepted', generationType: 'normal', hostMessageRef: index, hostVariantRef: swipe, variantId: id,
      injectedText: 'Frozen instruction', epoch: 0, unadjudicated: false, loreCursor: chain[index - 1], createdAt: index } satisfies GenerationAttempt;
    record.variants[id] = { variantId: id, attemptId: id, resolutionId: null, actorId: 'guide', cursorBefore: before, cursorAfter: after };
    if (!swipe) messages[index]!.extra.rpd = { a: id, v: id };
    const snapshot = { at: index, meters: { guide: { regard: index } }, knownBy: { clue: ['guide'] } };
    if (swipe) record.story.historyAliases = { [after]: chain[2]! };
    else record.story.history[after] = snapshot;
    record.story.lore[chain[index - 1]!] = { at: index, refs: [], requests: 0, books: [], failed: [] };
  }
  record.replyCheckRerolls = [chain[3]!];
  fingerprints[0]!.text = 'I ask for passage, politely.';
  messages[0]!.mes = fingerprints[0]!.text;
  const next = cursorChain('seed', fingerprints);
  const rebased = rebaseRecordCursors(record, messages, fingerprints);
  assert.equal(rebased.attempts.b!.cursorBefore, next[3]);
  assert.equal(rebased.variants.b!.cursorAfter, next[4]);
  assert.equal(rebased.attempts.b!.loreCursor, next[2]);
  assert.ok(rebased.story.lore[next[2]!]);
  assert.equal(snapshotAt(rebased.story, next)?.meters.guide!.regard, 3);
  const alternateAfter = extendCursor(next[1]!, { ...fingerprints[1]!, text: messages[1]!.swipes[1]! });
  assert.equal(rebased.variants.alternative!.cursorAfter, alternateAfter);
  assert.equal(snapshotAt(rebased.story, [alternateAfter])?.meters.guide!.regard, 1);
  assert.deepEqual(rebased.replyCheckRerolls, [next[3]]);
  assert.deepEqual(rebaseRecordCursors(rebased, messages, fingerprints), rebased, 'load migration is idempotent');
});

test('load preserves a markerless failed turn after an offline user edit', () => {
  const fingerprints: FingerprintMessage[] = [{ role: 'user', actorKey: 'persona', text: 'I open the gate.' }];
  const record = newRecord('seed', 'profile');
  record.transcriptCursors = cursorChain('seed', fingerprints);
  record.attempts.failed = { attemptId: 'failed', resolutionId: null, cursorBefore: record.transcriptCursors[1]!, actorId: 'guide',
    status: 'failed', generationType: 'normal', hostMessageRef: null, hostVariantRef: null, variantId: null,
    injectedText: 'Frozen instruction', epoch: 0, unadjudicated: false, createdAt: 1 };
  fingerprints[0]!.text = 'I open the gate!';
  const next = rebaseRecordCursors(record, [{ mes: fingerprints[0]!.text, is_user: true }], fingerprints);
  assert.equal(next.attempts.failed!.cursorBefore, cursorChain('seed', fingerprints)[1]);
});

test('rebasing a tool follow-up binds to the user before intermediary prose and tool records', () => {
  const fingerprints: FingerprintMessage[] = [
    { role: 'user', actorKey: 'persona', text: 'I demand entry.' },
    { role: 'assistant', actorKey: 'guide.png', text: 'The guide starts to answer.' },
    { role: 'system', actorKey: 'system', text: 'Tool result.' },
    { role: 'assistant', actorKey: 'guide.png', text: 'The gate stays shut.' },
  ];
  const chain = cursorChain('seed', fingerprints);
  const record = newRecord('seed', 'profile');
  record.transcriptCursors = chain;
  record.attempts.tool = { attemptId: 'tool', resolutionId: null, cursorBefore: chain[1]!, actorId: 'guide',
    status: 'accepted', generationType: 'normal', hostMessageRef: 3, hostVariantRef: 0, variantId: 'tool',
    injectedText: 'Frozen instruction', epoch: 0, unadjudicated: false, createdAt: 1 };
  record.variants.tool = { variantId: 'tool', attemptId: 'tool', resolutionId: null, actorId: 'guide', cursorBefore: chain[1]!, cursorAfter: chain[4]! };
  fingerprints[0]!.text = 'I demand entry!';
  const messages = fingerprints.map(message => ({ mes: message.text, is_user: message.role === 'user', is_system: message.role === 'system' }));
  const rebased = rebaseRecordCursors(record, messages, fingerprints, true);
  assert.equal(rebased.attempts.tool!.cursorBefore, cursorChain('seed', fingerprints)[1]);
  assert.equal(rebased.variants.tool!.cursorBefore, rebased.attempts.tool!.cursorBefore);
});
