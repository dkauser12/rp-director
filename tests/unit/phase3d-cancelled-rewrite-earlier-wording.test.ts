/**
 * The rewrite of an earlier wording (fix-list item 8: a Continue on swipe 0 of 3
 * is checked, and its rewrite goes to a new last swipe) is cancelled before a
 * fragment exists: non-streaming, the request is aborted, or streaming, Stop
 * lands before the first chunk. No swipe slot was created, so SillyTavern's
 * endSwipe() clamps swipe_id to the LAST swipe (script.js 10051-10082), not to
 * the wording the user was reading. discardAutomaticSwipe() then returns early
 * (swipe_id !== nextSwipe, host.ts ~683) and nothing restores originalSwipe.
 *
 * Item 3: "select the original swipe again ... the user is answering the original."
 */
import { test } from 'node:test';
import { rc, score, until, assert } from './support/phase3c-replycheck.ts';

test('typing cancels the rewrite of an earlier wording and leaves the user on that wording', async () => {
  let checks = 0;
  const h = await rc({ streaming: false, answers: request => ('speaks_for_user' in request.questions ? { speaks_for_user: score(++checks === 4 ? 4 : 0) } : {}) });
  await h.sim.clickSend('I nod. "Open the gate, please."');
  await until(() => h.checks().length === 1, 'check 1');
  await h.sim.swipeRight(); await until(() => h.checks().length === 2, 'check 2');
  await h.sim.swipeRight(); await until(() => h.checks().length === 3, 'check 3');
  await h.sim.settle();
  await h.sim.swipeLeft(); await h.sim.swipeLeft(); await h.sim.settle();
  assert.equal(h.last().swipe_id, 0, 'sanity: reading the first wording');
  // The user continues the first wording; its check asks for a rewrite, whose
  // request is aborted when the user starts typing an answer.
  h.sim.writer = [{ text: 'and waits.' }, { fail: 'request aborted by stopGeneration' }];
  const interceptor = h.controller.interceptor.bind(h.controller);
  let typed = false;
  h.controller.interceptor = async (chat: unknown, size: number, abort: (i: boolean) => void, type: string) => {
    await interceptor(chat, size, abort, type);
    if (type === 'swipe' && !typed) { typed = true; h.type('I answer the guide.'); }
  };
  await h.sim.generate('continue');
  await until(() => typed, 'the rewrite reached the writer');
  await h.sim.settle();
  const continued = h.last().swipes[0];
  console.log(`selected swipe ${h.last().swipe_id} of ${h.last().swipes.length}:`, JSON.stringify(h.last().mes), '|', h.sim.log.slice(-6).join(' | '));
  assert.ok(continued.endsWith('and waits.'), 'sanity: swipe 0 is the continued wording');
  assert.equal(h.last().swipes.length, 3, 'sanity: no fragment was kept');
  assert.equal(h.last().swipe_id, 0, 'the user is left on the wording they were answering');
  assert.equal(h.last().mes, continued);
});
