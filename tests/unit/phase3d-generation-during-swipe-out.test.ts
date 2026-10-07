/**
 * Fix-list item 4 by another route. A user generation that starts while the
 * automatic swipe is still in its swipe-out animation (Continue here; /continue,
 * a Quick Reply or Ctrl+Enter behave alike, since is_send_press is still false)
 * reaches onGenerationStarted()'s non-own branch, which cancels the rewrite and
 * then sets `this.automaticReply = null` (controller.ts ~1946-1949). The identity
 * that item 4 keeps "until the single native swipe dispatch settles" is gone
 * before SillyTavern emits that swipe's MESSAGE_SWIPED, so onMessageSwiped()
 * treats the Director's own swipe as the user's: the W3 popup opens for a swipe
 * the user never started, and Keep leaves approvedSwipeCursor armed (Generate is
 * skipped because is_send_press is now true).
 */
import { test } from 'node:test';
import { rc, score, until, assert } from './support/phase3c-replycheck.ts';
import { sim2 } from './support/phase3b-workflow.ts';

test('a Continue during the automatic swipe-out opens no W3 popup and leaves nothing armed', async t => {
  const h = await rc({ streaming: true, outMs: 30, inMs: 5, askWhenSwiping: true,
    answers: request => ('speaks_for_user' in request.questions ? { speaks_for_user: score(4) } : {}) });
  t.after(() => h.controller.destroy());
  // The Continue's request is still streaming when the swipe's MESSAGE_SWIPED returns (as with a real API).
  h.sim.writer = [{ text: 'Player agrees to follow the guide.' }, { text: 'and waits.', delayMs: 150 }];
  let continued = false;
  h.onSwipeOut(() => { continued = true; void h.sim.generate('continue'); });
  await h.sim.clickSend('I nod. "Open the gate, please."');
  await until(() => continued, 'the automatic swipe started');
  await h.sim.settle();
  console.log(`popups: ${h.popups.length}; approvedSwipeCursor ${h.controller.approvedSwipeCursor ? 'armed' : 'clear'}; explicitRetry ${h.controller.explicitRetry ? 'armed' : 'clear'}`, '|', h.sim.log.slice(-10).join(' | '));
  assert.equal(h.popups.length, 0, 'no "Keep the result / Roll again / Cancel" popup for the Director\'s own swipe');
  assert.equal(h.controller.approvedSwipeCursor, null, 'no approval is left armed for a later swipe');
});

test('Cancel in that unexpected popup does not swallow the user\'s next swipe', async t => {
  const h = await rc({ streaming: true, outMs: 30, inMs: 5, askWhenSwiping: true,
    answers: request => ('speaks_for_user' in request.questions ? { speaks_for_user: score(4) } : {}) });
  t.after(() => h.controller.destroy());
  h.sim.writer = [{ text: 'Player agrees to follow the guide.' }, { text: 'and waits.', delayMs: 150 }];
  h.host.swipeResult = async () => { h.popups.push('W3'); return 'cancel'; };
  let continuation: Promise<void> | null = null;
  h.onSwipeOut(() => { continuation = h.sim.generate('continue'); });
  await h.sim.clickSend('I nod. "Open the gate, please."');
  await until(() => continuation !== null, 'the automatic swipe started');
  await continuation; await h.sim.settle();
  h.host.swipeResult = async () => { h.popups.push('W3'); return 'reuse'; };
  const swipes = h.last().swipes.length;
  await h.sim.swipeRight(); // the user now asks for a new wording
  await h.sim.settle();
  console.log(`cancelSwipe ${h.controller.cancelSwipe}; swipes ${swipes} -> ${h.last().swipes.length}`, '|', h.sim.log.slice(-6).join(' | '));
  assert.ok(!h.sim.log.slice(-6).includes('aborted swipe'), 'the user\'s swipe is not aborted by a stale cancel');
  assert.equal(h.last().swipes.length, swipes + 1, 'the user\'s swipe produced a new wording');
});

/**
 * Phase 3d, found beside item 4: a Cancel is only ever for the swipe it was chosen
 * for. Another extension's quiet generation started inside that swipe's own
 * GENERATION_STARTED listeners reaches the interceptor first; it used to be aborted
 * itself and consume the Cancel, so the cancelled swipe was written anyway.
 */
test("a quiet generation inside the swipe's start never consumes that swipe's Cancel", async t => {
  const sim: any = await sim2();
  t.after(() => sim.controller.destroy());
  await sim.clickSend('I nod. "Open the gate, please."');
  sim.controller.settings.askWhenSwiping = true;
  sim.host.swipeResult = async () => 'cancel';
  let quietAborted = false;
  sim.host.context.eventSource.on('GENERATION_STARTED', async (type: string) => {
    if (type === 'swipe') await sim.controller.interceptor([], 4096, () => { quietAborted = true; }, 'quiet');
  });
  const swipes = sim.host.chat().at(-1).swipes.length;
  await sim.swipeRight(); await sim.settle();
  console.log(sim.log.slice(-6).join(' | '));
  assert.equal(quietAborted, false, "the other extension's quiet generation runs");
  assert.ok(sim.log.includes('aborted swipe'), 'the swipe the user cancelled is not written');
  assert.equal(sim.host.chat().at(-1).swipes.length, swipes);
});
