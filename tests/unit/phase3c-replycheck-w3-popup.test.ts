/**
 * ST's swipe() sets swipe_id, plays the swipe-out animation and only then awaits
 * MESSAGE_SWIPED (script.js 10271-10320). If the user types in that window,
 * cancelReplyCheck() clears automaticReply and approvedSwipeCursor, so
 * onMessageSwiped (controller.ts 2039-2060) treats the automatic swipe as the
 * user's own swipe of a ruled reply and opens the W3 choice. Whatever the user
 * picks, prepareGeneration then aborts the swipe via cancelledReplySwipe
 * (1590-1598), which returns before `cancelSwipe` is consumed (1602).
 */
import { test } from 'node:test';
import { rc, score, until, assert } from './support/phase3c-replycheck.ts';

async function typeDuringSwipeOut(choice: 'reuse' | 'cancel' | 'reroll') {
  const h = await rc({ streaming: true, outMs: 30, inMs: 5, askWhenSwiping: true,
    answers: request => ('speaks_for_user' in request.questions ? { speaks_for_user: score(4) } : {}) });
  h.host.swipeResult = async () => { h.popups.push('W3'); return choice; };
  let typed = false;
  h.onSwipeOut(() => { typed = true; h.type('I'); });
  await h.sim.clickSend('I nod. "Open the gate, please."');
  await until(() => typed, 'the automatic swipe started');
  await h.sim.settle();
  console.log(`popups: ${h.popups.length}`, h.sim.log.join(' | '));
  return h;
}

test('typing during the swipe-out animation cancels the rewrite without a W3 popup', async () => {
  const h = await typeDuringSwipeOut('reuse');
  assert.equal(h.popups.length, 0, 'no "Keep the result / Roll again / Cancel" popup for a swipe the user did not ask for');
});

test('choosing Cancel in that popup does not swallow the user\'s next Continue', async () => {
  const h = await typeDuringSwipeOut('cancel');
  h.host.composerValue = '';
  await h.sim.generate('continue');
  await h.sim.settle();
  console.log(h.sim.log.slice(-6).join(' | '));
  assert.ok(!h.sim.log.includes('aborted continue'), 'the next Continue is written');
});

test('choosing Roll again in that popup does not throw away the new draw', async () => {
  const h = await typeDuringSwipeOut('reroll');
  const resolutions = Object.keys(h.controller.record.resolutions).length;
  console.log(`resolutions after the popup: ${resolutions}; last reply swipes: ${h.last().swipes.length}`);
  // Either no second draw was made, or the new draw reached a reply.
  assert.ok(resolutions === 1 || h.last().swipes.length === 2, 'an explicit Roll again is never drawn and then silently dropped');
});
