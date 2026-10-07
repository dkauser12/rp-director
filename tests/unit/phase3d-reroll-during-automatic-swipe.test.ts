/**
 * Race (b): an explicit Roll again (badge popup or /director-reroll) while the
 * automatic rewrite's native swipe is still animating.
 *
 * During swipe()'s swipe-out animation is_send_press is still false, so
 * decisionCommandUnavailable() lets reroll() through. changeDecision() cancels
 * the automatic reply, freezes a new draw, sets explicitRetry and starts a second
 * native swipe (source slash_command bypasses ST's one-swipe-at-a-time guard).
 * The first swipe then emits MESSAGE_SWIPED and SillyTavern still calls
 * Generate('swipe'); prepareGeneration's cancelled branch aborts it and clears
 * explicitRetry (controller.ts ~1746). The second swipe is then written with the
 * old ruling, or, when the first swipe's endSwipe() reverts swipe_id first,
 * written over the reply the check judged.
 *
 * Doctrine: an explicit Roll again either does not draw at all or its new draw
 * reaches a reply. Swipes the user kept are never overwritten.
 *
 * Phase 3d (fix-list item 1): while the automatic reply is set or SillyTavern's
 * swipe state is not 'none', Roll again, Reassess, Try the judge again and the
 * managed Regenerate refuse without drawing: "Wait for the current reply to finish."
 */
import { test } from 'node:test';
import { rc, score, until, assert } from './support/phase3c-replycheck.ts';
import { installFaithfulSwipe } from './support/faithful-swipe.ts';

const puppet = (request: any) => ('speaks_for_user' in request.questions ? { speaks_for_user: score(4) } : {});
const original = 'Player agrees to follow the guide.';

// In real ST each swipe's animateSwipeTransition restarts the one CSS animation,
// ending the other swipe's running animation early; so both timings interleave alike.
for (const timing of [{ outMs: 60, inMs: 20 }, { outMs: 60, inMs: 0 }]) {
  test(`Roll again during the automatic swipe's animation (swipe-out ${timing.outMs} ms, swipe-in ${timing.inMs} ms)`, async t => {
    const h = await rc({ streaming: true, answers: puppet });
    t.after(() => h.controller.destroy());
    installFaithfulSwipe(h, timing);
    h.sim.writer = [{ text: original }];
    const send = h.sim.clickSend('I nod. "Open the gate, please."');
    await until(() => Boolean(h.controller.automaticReply) && !h.controller.automaticReply.swipeObserved, 'the automatic swipe is animating');
    const rolled = await h.controller.reroll(true);
    await send; await h.sim.settle();
    // Compaction deletes an unused draw from record.resolutions; Activity keeps the "Rerolled" entry.
    const drawn = h.controller.record.inspector.filter((entry: any) => entry.kind === 'reroll' && entry.resolutionId).map((entry: any) => entry.resolutionId);
    const attempts = Object.values<any>(h.controller.record.attempts);
    const used = attempts.filter(attempt => attempt.status === 'accepted' && drawn.includes(attempt.resolutionId));
    console.log(`reroll returned ${rolled}; new draws ${drawn.length}; accepted attempts using them ${used.length};`,
      `swipes ${JSON.stringify(h.last().swipes)} at ${h.last().swipe_id};`, h.sim.log.slice(-14).join(' | '));
    assert.ok(drawn.length === 0 || used.length > 0, 'an explicit Roll again is never drawn and then silently dropped');
    assert.ok(h.last().swipes.includes(original), 'the reply the check judged is never overwritten');
    assert.equal(rolled, false, 'Roll again refuses while the automatic swipe runs');
    assert.ok(h.host.notices.includes('Wait for the current reply to finish.'), 'and says why');
  });
}

for (const action of ['reassess', 'retryJudge', 'regenerateSelected'] as const) {
  test(`${action} during the automatic swipe's animation is refused and leaves the rewrite alone`, async t => {
    const h = await rc({ streaming: true, answers: puppet });
    t.after(() => h.controller.destroy());
    installFaithfulSwipe(h, { outMs: 60, inMs: 20 });
    h.sim.writer = [{ text: original }];
    const send = h.sim.clickSend('I nod. "Open the gate, please."');
    await until(() => Boolean(h.controller.automaticReply) && !h.controller.automaticReply.swipeObserved, 'the automatic swipe is animating');
    const resolutions = Object.keys(h.controller.record.resolutions).length;
    await h.controller[action]();
    await send; await h.sim.settle();
    assert.ok(h.host.notices.includes('Wait for the current reply to finish.'), 'refused with one plain sentence');
    assert.equal(Object.keys(h.controller.record.resolutions).length, resolutions, 'nothing was judged or drawn');
    assert.ok(h.last().swipes.includes(original), 'the reply the check judged is kept');
    assert.ok(Object.values<any>(h.controller.record.attempts).some(attempt => attempt.rerolledByCheck && attempt.status === 'accepted'),
      'the automatic rewrite still completes');
  });
}
