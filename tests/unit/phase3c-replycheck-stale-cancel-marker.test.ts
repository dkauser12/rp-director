/**
 * cancelReplyCheck() records `cancelledReplySwipe = { message, nextSwipe }` whenever
 * `automaticReply` is still set (controller.ts 1874-1878). Only prepareGeneration's
 * own abort (1590-1598) or the interceptor's cancel branch (1576-1580) clears it.
 * When the automatic swipe's generation already went through the interceptor, or
 * already completed, nothing consumes the marker, and the next swipe generation of
 * that message at the same index is silently aborted (ST reverts it with a shake).
 */
import { test } from 'node:test';
import { rc, score, until, assert } from './support/phase3c-replycheck.ts';

const puppet = (request: any) => ('speaks_for_user' in request.questions ? { speaks_for_user: score(4) } : {});

test('non-streaming: typing aborts the automatic rewrite mid-request; the next manual swipe must still generate', async () => {
  const h = await rc({ streaming: false, outMs: 5, inMs: 5, answers: puppet });
  // Step 1 answers the Send; step 2 is the automatic swipe, whose request the Stop aborts.
  h.sim.writer = [{ text: 'The guide opens the gate and Player thanks him warmly.' }, { fail: 'request aborted by stopGeneration' }];
  const interceptor = h.controller.interceptor.bind(h.controller);
  let typed = false;
  h.controller.interceptor = async (chat: unknown, size: number, abort: (i: boolean) => void, type: string) => {
    await interceptor(chat, size, abort, type);
    if (type === 'swipe' && !typed) { typed = true; h.type('Wait, I'); }
  };
  await h.sim.clickSend('I nod. "Open the gate, please."');
  await until(() => typed, 'the automatic swipe reached the writer');
  await h.sim.settle();
  assert.equal(h.stops(), 1, 'typing stopped the automatic rewrite');
  assert.equal(h.last().swipes.length, 1, 'the aborted non-streaming swipe was reverted');
  // The user clears the draft and asks for a new wording with the swipe arrow.
  h.host.composerValue = '';
  await h.sim.swipeRight();
  await h.sim.settle();
  console.log(h.sim.log.join(' | '));
  assert.ok(!h.sim.log.slice(-8).includes('aborted swipe'), 'the manual swipe is not aborted by the cancelled automatic swipe');
  assert.equal(h.last().swipes.length, 2, 'the manual swipe produced a new reply');
});

test('non-streaming: Stop during the automatic rewrite; the next "Roll again" must reach a reply with its new draw', async () => {
  const h = await rc({ streaming: false, outMs: 5, inMs: 5, answers: puppet });
  h.sim.writer = [{ text: 'The guide opens the gate and Player thanks him warmly.' }, { fail: 'request aborted by stopGeneration' }];
  const interceptor = h.controller.interceptor.bind(h.controller);
  let stopped = false;
  h.controller.interceptor = async (chat: unknown, size: number, abort: (i: boolean) => void, type: string) => {
    await interceptor(chat, size, abort, type);
    if (type === 'swipe' && !stopped) { stopped = true; h.sim.stop(); } // the user presses Stop
  };
  await h.sim.clickSend('I nod. "Open the gate, please."');
  await until(() => stopped, 'the automatic swipe reached the writer');
  await h.sim.settle();
  assert.equal(h.last().swipes.length, 1, 'the aborted non-streaming swipe was reverted');
  const firstDraw = Object.values<any>(h.controller.record.resolutions)[0].resolutionId;
  const rolled = await h.controller.reroll(true); // badge popup [Roll again] or /director-reroll
  await h.sim.settle();
  console.log(`reroll returned ${rolled};`, h.sim.log.slice(-6).join(' | '));
  const latest = Object.values<any>(h.controller.record.attempts).sort((a, b) => a.createdAt - b.createdAt).at(-1);
  assert.equal(h.last().swipes.length, 2, 'Roll again produced a new swipe');
  assert.notEqual(latest.resolutionId, firstDraw, 'the new swipe uses the new draw');
});

test('streaming, real ST order: after a completed automatic rewrite, delete it and swipe again: the swipe must generate', async () => {
  // Generate('swipe') resolves only after saveChatConditional(); the rewrite's
  // completion (setTimeout + persist) schedules its own check before swipe() returns.
  const h = await rc({ streaming: true, outMs: 5, inMs: 5, saveLatencyMs: 25, answers: puppet });
  await h.sim.clickSend('I nod. "Open the gate, please."');
  await until(() => h.checks().length === 2, 'both checks');
  await h.sim.settle();
  assert.equal(h.last().swipes.length, 2, 'one automatic rewrite');
  assert.equal(h.last().swipe_id, 1);
  // "The original reply is one swipe to the left": the user deletes the rewrite...
  await h.deleteSwipe();
  assert.equal(h.last().swipes.length, 1);
  // ...and asks for a new wording.
  await h.sim.swipeRight();
  await h.sim.settle();
  console.log(h.sim.log.join(' | '));
  assert.ok(!h.sim.log.slice(-8).includes('aborted swipe'), 'the manual swipe is not aborted');
  assert.equal(h.last().swipes.length, 2, 'the manual swipe produced a new reply');
});
