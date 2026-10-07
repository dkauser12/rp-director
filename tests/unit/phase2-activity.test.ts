import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityTurns, activityMetrics, playerUiText } from '../../src/activity.ts';
import type { HostChatMessage } from '../../src/host.ts';
import type { InspectorEntry } from '../../src/types.ts';
import type { WorkflowBadge } from '../../src/workflow-badge.ts';

function message(mes: string, extra: Partial<HostChatMessage> = {}): HostChatMessage {
  return { name: 'Guide', is_user: false, is_system: false, mes, ...extra };
}

function badge(attemptId: string): WorkflowBadge {
  return { schemaVersion: 1, attemptId, unavailable: false, errors: [], results: [], reaction: null };
}

function entry(id: string, overrides: Partial<InspectorEntry> = {}): InspectorEntry {
  return {
    id, at: 1, epoch: 1, kind: 'director_send', attemptId: null, resolutionId: null, actionId: null,
    applicability: null, questions: null, stateSent: null, answers: null, speaker: null, policyBandId: null,
    draw: null, outcome: null, injectedText: null, providerKind: null, requestedModel: null, returnedModel: null,
    durationMs: null, inputTokens: null, outputTokens: null, networkCalls: 0, message: 'Turn completed.', ...overrides,
  };
}

test('Activity shows the last 20 replies in transcript order and skips non-replies', () => {
  const chat: HostChatMessage[] = [message('Scene note.', { is_system: true })];
  const replies: number[] = [];
  for (let turn = 0; turn < 24; turn++) {
    chat.push(message(`Move ${turn}.`, { name: 'Player', is_user: true }));
    replies.push(chat.length);
    chat.push(message(`Reply ${turn}.`, { swipe_id: 0, swipes: [`Reply ${turn}.`, 'Other wording.'] }));
  }
  chat.push(message('  \n '));
  const readIds: number[] = [];
  const turns = activityTurns(chat, id => { readIds.push(id); return null; }, []);
  assert.equal(turns.length, 20);
  assert.deepEqual(turns.map(turn => turn.messageId), replies.slice(-20));
  assert.ok(readIds.every(id => replies.includes(id)), 'only visible replies can have Activity details');
  assert.ok(turns.every(turn => turn.swipeId === 0 && turn.badge === null && turn.entries.length === 0));
});

test('Activity follows the selected swipe and associates only that attempt’s inspection entries', () => {
  const chat = [message('A move.', { is_user: true }), message('Second wording.', { swipe_id: 1, swipes: ['First wording.', 'Second wording.'] })];
  const first = badge('first-attempt');
  const second = badge('second-attempt');
  const badges = [first, second];
  const entries = [
    entry('first', { attemptId: first.attemptId }),
    entry('second-a', { attemptId: second.attemptId }),
    entry('unrelated', { attemptId: 'other-attempt' }),
    entry('second-b', { attemptId: second.attemptId }),
  ];
  const readBadge = (id: number) => badges[chat[id]!.swipe_id ?? 0] ?? null;
  const before = JSON.stringify(entries);
  const selected = activityTurns(chat, readBadge, entries);
  assert.equal(selected.length, 1, 'wording alternatives do not become separate turns');
  assert.equal(selected[0]!.swipeId, 1);
  assert.equal(selected[0]!.badge, second);
  assert.deepEqual(selected[0]!.entries.map(value => value.id), ['second-a', 'second-b']);
  chat[1]!.swipe_id = 0;
  chat[1]!.mes = 'First wording.';
  const previous = activityTurns(chat, readBadge, entries);
  assert.equal(previous[0]!.badge, first);
  assert.deepEqual(previous[0]!.entries.map(value => value.id), ['first']);
  assert.equal(JSON.stringify(entries), before, 'reading Activity must not rewrite saved entries');
});

test('Activity distinguishes unavailable measurements from measured zero', () => {
  assert.deepEqual(activityMetrics([]), { requests: null, durationMs: null });
  assert.deepEqual(activityMetrics([entry('known-zero', { durationMs: 0 })]), { requests: 0, durationMs: 0 });
  assert.deepEqual(activityMetrics([entry('no-duration', { networkCalls: 2 })]), { requests: 2, durationMs: null });
  assert.deepEqual(activityMetrics([
    entry('one', { networkCalls: 1, durationMs: 12 }),
    entry('two', { networkCalls: 2, durationMs: 23 }),
  ]), { requests: 3, durationMs: 35 });
});

test('player labels replace full names without changing larger names or saved text', () => {
  const text = 'Kai meets Kaila, McKai, Kai_2 and ÉKai; Kai asks Kai.';
  assert.equal(playerUiText(text, 'Kai'), '{{user}} meets Kaila, McKai, Kai_2 and ÉKai; {{user}} asks {{user}}.');
  assert.equal(text, 'Kai meets Kaila, McKai, Kai_2 and ÉKai; Kai asks Kai.');
  assert.equal(playerUiText('A meets A\u0301ri.', 'A'), '{{user}} meets A\u0301ri.');
  assert.equal(playerUiText('Kai\u0301 walks past.', 'Kai'), 'Kai\u0301 walks past.');
});

test('player labels treat regex characters literally and leave missing names alone', () => {
  assert.equal(playerUiText('A.[x] asks A.[x]; Azzx waits.', 'A.[x]'), '{{user}} asks {{user}}; Azzx waits.');
  assert.equal(playerUiText('C++ meets C+ and C.', 'C++'), '{{user}} meets C+ and C.');
  const text = '{{user}} asks the guide.';
  for (const name of [undefined, '', '   ', '{{user}}']) assert.equal(playerUiText(text, name), text);
});
