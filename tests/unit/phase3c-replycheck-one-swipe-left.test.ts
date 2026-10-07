/**
 * The rewrite always goes to a new last swipe (nextSwipe = swipes.length,
 * controller.ts 1968-1969; Host.swipeRight forceSwipeId = swipes.length), but the
 * badge popup always says "The original reply is one swipe to the left."
 * (ui.ts 267). A Continue on an earlier swipe is checked like any reply, so its
 * rewrite lands several swipes away from the reply it replaces.
 */
import { test } from 'node:test';
import { rc, score, until, assert } from './support/phase3c-replycheck.ts';

test('the rewritten reply records the original swipe index when other wordings lie between them', async () => {
  let checks = 0;
  const h = await rc({ answers: request => ('speaks_for_user' in request.questions ? { speaks_for_user: score(++checks === 4 ? 4 : 0) } : {}) });
  await h.sim.clickSend('I nod. "Open the gate, please."');
  await until(() => h.checks().length === 1, 'check 1');
  await h.sim.swipeRight(); await until(() => h.checks().length === 2, 'check 2');
  await h.sim.swipeRight(); await until(() => h.checks().length === 3, 'check 3');
  await h.sim.settle();
  await h.sim.swipeLeft(); await h.sim.swipeLeft(); await h.sim.settle();
  assert.equal(h.last().swipe_id, 0);
  const continued = h.sim.generate('continue'); // the user continues the first wording
  await continued;
  await until(() => h.checks().length === 4, 'the continued reply is checked');
  await h.sim.settle();
  const last = h.last();
  console.log(`rewrite at swipe ${last.swipe_id} of ${last.swipes.length}; continued original is swipe 0`);
  assert.ok(Object.values<any>(h.controller.record.attempts).some(a => a.rerolledByCheck), 'the automatic rewrite ran');
  assert.equal(last.swipe_id, 3, 'native rewrites append after all existing wordings');
  assert.equal(h.host.readWorkflowBadge(h.host.chat().length - 1).replyOriginalSwipe, 0, 'badge identifies the actual original');
});
