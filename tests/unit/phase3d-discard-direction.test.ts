/**
 * Phase 3d, items 5 and 6: Host.discardAutomaticSwipe after an unfinished rewrite.
 *
 * - Item 6: removing the fragment and showing the original moves to a lower
 *   index, so it animates left, like SillyTavern's own deleteSwipe()
 *   (script.js 9339-9399: direction = swipeId <= newSwipeId ? right : left).
 * - Item 5: with no fragment slot, endSwipe() clamped the selection to the last
 *   swipe; the original is selected again, nothing is removed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Host } from '../../src/host.ts';
import type { HostChatMessage } from '../../src/host.ts';

function fakeHost(message: HostChatMessage) {
  const host = new Host();
  const swipes: { direction: string; options: Record<string, unknown> }[] = [];
  const deleted: unknown[] = [];
  const context = {
    chat: [{ name: 'Player', is_user: true, is_system: false, mes: 'I wait.' }, message],
    chatMetadata: {} as Record<string, unknown>,
    eventTypes: { MESSAGE_SWIPE_DELETED: 'MESSAGE_SWIPE_DELETED' },
    eventSource: { emit: async (_name: string, details: unknown) => { deleted.push(details); } },
    swipe: {
      to: async (_event: unknown, direction: string, options: Record<string, unknown>) => {
        swipes.push({ direction, options });
        message.swipe_id = options.forceSwipeId as number;
        message.mes = message.swipes![message.swipe_id]!;
      },
      state: () => 'none',
    },
    saveChat: async () => {},
  };
  (host as any).ctx = () => context;
  return { host, swipes, deleted };
}

const reply = (swipes: string[], swipeId: number): HostChatMessage => ({ name: 'Guide', is_user: false, is_system: false,
  mes: swipes[swipeId] ?? '', swipe_id: swipeId, swipes: [...swipes], swipe_info: swipes.map(() => ({ extra: {} })), extra: {} });

test('phase3d: discarding a rewrite fragment animates left to the original', async () => {
  const message = reply(['Original.', 'Other wording.', 'The guide sta'], 2);
  const { host, swipes, deleted } = fakeHost(message);
  assert.equal(await host.discardAutomaticSwipe(message, 2, 0), true);
  assert.deepEqual(message.swipes, ['Original.', 'Other wording.'], 'the fragment slot is removed');
  assert.deepEqual(deleted, [{ messageId: 1, swipeId: 2, newSwipeId: 0 }]);
  assert.deepEqual(swipes.map(swipe => [swipe.direction, swipe.options.source, swipe.options.forceSwipeId]), [['left', 'delete', 0]]);
  assert.equal(message.mes, 'Original.');
});

test('phase3d: with no fragment slot the clamped selection returns to the original, removing nothing', async () => {
  // A Continue on swipe 0 of 3 was checked; its rewrite (slot 3) never got a chunk,
  // and endSwipe() clamped swipe_id to the last swipe.
  const message = reply(['Original, continued.', 'Second.', 'Third.'], 2);
  const { host, swipes, deleted } = fakeHost(message);
  assert.equal(await host.discardAutomaticSwipe(message, 3, 0, false), true);
  assert.deepEqual(message.swipes, ['Original, continued.', 'Second.', 'Third.']);
  assert.deepEqual(deleted, [], 'nothing is deleted');
  assert.deepEqual(swipes.map(swipe => [swipe.direction, swipe.options.forceSwipeId]), [['left', 0]]);
  assert.equal(message.mes, 'Original, continued.');
});

test('phase3d: a failed (not cancelled) rewrite never removes a written slot', async () => {
  const message = reply(['Original.', 'A complete rewrite the Director did not recognise.'], 1);
  const { host, swipes } = fakeHost(message);
  assert.equal(await host.discardAutomaticSwipe(message, 1, 0, false), false);
  assert.equal(message.swipes!.length, 2);
  assert.deepEqual(swipes, []);
});
