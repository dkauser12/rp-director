/**
 * The check of a reply written by the user's own swipe can finish while that
 * swipe() is still in endSwipe(): Generate('swipe') resolves only after
 * saveChatConditional() (script.js 3808-3818, 5561-5575), and endSwipe() then
 * clamps swipe_id (10051-10082). checkReply() waits only for the Director's own
 * writer (writerSettled) and is_send_press, never for ST's swipe state, and
 * Host.swipeRight() uses source 'slash_command', which bypasses ST's
 * one-swipe-at-a-time guard. The user's endSwipe() then reverts the automatic
 * overswipe, the automatic swipe is no longer recognised as the Director's own,
 * and its generation is written into the swipe the check judged.
 */
import { test } from 'node:test';
import { rc, score, until, assert } from './support/phase3c-replycheck.ts';

test('a fast check after a slow-saving user swipe never overwrites the reply it judged', async t => {
  let checks = 0;
  const h = await rc({ streaming: true, outMs: 5, inMs: 5, saveLatencyMs: 150,
    answers: request => ('speaks_for_user' in request.questions ? { speaks_for_user: score(++checks === 2 ? 4 : 0) } : {}) });
  t.after(() => h.controller.destroy());
  await h.sim.clickSend('I nod. "Open the gate, please."');
  await until(() => h.checks().length === 1, 'check 1');
  await h.sim.settle();
  const judged = 'Player agrees to follow the guide.';
  h.sim.writer = [{ text: judged }];
  // Real streaming creates the new swipe slot only at the first chunk (onStartStreaming ->
  // saveReply, script.js 3621-3641), after the request's latency; the harness creates it at once.
  const interceptor = h.controller.interceptor.bind(h.controller);
  h.controller.interceptor = async (chat: unknown, size: number, abort: (i: boolean) => void, type: string) => {
    const automatic = type === 'swipe' && Boolean(h.controller.automaticReply);
    await interceptor(chat, size, abort, type);
    if (automatic) await new Promise(resolve => setTimeout(resolve, 300));
  };
  await h.sim.swipeRight(); // the user's swipe; its check (fast judge) asks for a rewrite
  await until(() => h.checks().length >= 2, 'check 2');
  await h.sim.settle();
  console.log(`swipes ${JSON.stringify(h.last().swipes)} at ${h.last().swipe_id}`, '|', h.sim.log.slice(-12).join(' | '));
  assert.ok(h.last().swipes.includes(judged), 'the judged reply is still one of the swipes');
});
