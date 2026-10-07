/**
 * Phase 3d, item 20. A badge belongs to its swipe: refreshWorkflowBadge() and
 * attemptAt() accept a marker only while the attempt's hostVariantRef equals the
 * message's swipe_id. SillyTavern's deleteSwipe() (script.js 9339-9399) splices
 * the swipe out, so every later swipe moves down one index; before 3d their
 * badges were cleared as mismatched, and "The original reply is swipe N" named
 * the wrong swipe (or vanished with the badge).
 */
import test from 'node:test';
import { rc, score, until, assert } from './support/phase3c-replycheck.ts';

const markers = (message: any) => message.swipe_info.map((info: any) => info?.extra?.rpd?.a ?? null);

test('phase3d: deleting earlier swipes keeps later badges and the original-reply index', async t => {
  let checks = 0;
  // The third wording is checked as writing for {{user}}: its rewrite lands at swipe 4 (index 3).
  const h = await rc({ answers: request => ('speaks_for_user' in request.questions ? { speaks_for_user: score(++checks === 3 ? 4 : 0) } : {}) });
  t.after(() => h.controller.destroy());
  await h.sim.clickSend('I nod. "Open the gate, please."');
  await until(() => h.checks().length === 1, 'check 1');
  await h.sim.swipeRight(); await until(() => h.checks().length === 2, 'check 2');
  await h.sim.swipeRight(); await until(() => h.checks().length === 4, 'the rewrite and its check');
  await h.sim.settle();
  const message = h.last();
  assert.equal(message.swipes.length, 4, 'sanity: three wordings and one rewrite');
  const [first, , third, rewrite] = markers(message);
  assert.equal(h.host.readWorkflowBadge(h.host.chat().length - 1)?.replyOriginalSwipe, 2, 'sanity: the rewrite names its original');
  assert.equal(h.host.readWorkflowBadge(h.host.chat().length - 1)?.attemptId, rewrite);

  // SillyTavern's deleteSwipe() of an earlier, unselected swipe: no MESSAGE_SWIPED follows.
  message.swipes.splice(0, 1); message.swipe_info.splice(0, 1); message.swipe_id = 2;
  await h.host.emit('MESSAGE_SWIPE_DELETED', { messageId: h.host.chat().length - 1, swipeId: 0, newSwipeId: 2 });
  await h.sim.settle();
  const badge = h.host.readWorkflowBadge(h.host.chat().length - 1);
  assert.equal(badge?.attemptId, rewrite, 'the selected rewrite keeps its badge');
  assert.equal(badge?.rerolledByCheck, 'writes for {{user}}');
  assert.equal(badge?.replyOriginalSwipe, 1, 'its original moved from swipe 3 to swipe 2');

  await h.sim.swipeLeft(); await h.sim.settle();
  assert.equal(h.last().swipe_id, 1);
  assert.equal(h.host.readWorkflowBadge(h.host.chat().length - 1)?.attemptId, third, 'the original keeps its own badge too');
  assert.notEqual(third, first);

  // Deleting the original itself: the rewrite no longer names a swipe that is gone.
  await h.deleteSwipe();
  assert.equal(h.last().swipe_id, 1, 'sanity: the rewrite is selected after the delete');
  const after = h.host.readWorkflowBadge(h.host.chat().length - 1);
  assert.equal(after?.attemptId, rewrite, 'the rewrite keeps its badge');
  assert.equal(after?.replyOriginalSwipe, -1, 'the popup says the original was deleted');
});
