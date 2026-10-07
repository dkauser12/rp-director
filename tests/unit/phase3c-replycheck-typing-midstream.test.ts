/**
 * Typing while the automatic rewrite streams calls host.stopGeneration()
 * (cancelReplyCheck, controller.ts 1881-1883). SillyTavern keeps a stopped
 * stream: onStopStreaming() only sets isFinished, so onFinishStreaming() saves the
 * partial text as the new swipe and emits MESSAGE_RECEIVED (script.js 3847-3850,
 * 5408-5447). And ST's stopGeneration() emits GENERATION_ENDED (hideStopButton)
 * before GENERATION_STOPPED (script.js 5607-5619); when the Director's ENDED
 * listener runs first it moves currentAttemptId into completionCandidate, so the
 * clearGeneration() calls that follow cancel nothing.
 */
import { test } from 'node:test';
import { rc, score, until, attempts, assert } from './support/phase3c-replycheck.ts';

const original = 'The guide opens the gate, and Player thanks him and walks through.';
const partial = 'The guide sets down his lan';

async function typeDuringRewrite() {
  const h = await rc({ streaming: true, outMs: 5, inMs: 5,
    answers: request => ('speaks_for_user' in request.questions ? { speaks_for_user: score(4) } : {}) });
  h.sim.writer = [{ text: original }, { delayMs: 300, get text() { return h.stops() ? partial : 'The guide sets down his lantern and waits.'; } }];
  const interceptor = h.controller.interceptor.bind(h.controller);
  let started = false;
  h.controller.interceptor = async (chat: unknown, size: number, abort: (i: boolean) => void, type: string) => {
    await interceptor(chat, size, abort, type);
    if (type === 'swipe' && !started) { started = true; setTimeout(() => h.type('I step thro'), 40); }
  };
  await h.sim.clickSend('I nod. "Open the gate, please."');
  await until(() => started && h.stops() > 0, 'typing during the rewrite');
  await h.sim.settle();
  const last = h.last();
  console.log(attempts(h.sim), `swipe ${last.swipe_id}/${last.swipes.length}:`, JSON.stringify(last.mes), `checks: ${h.checks().length}`, h.sim.log.join(' | '));
  return h;
}

test('typing during the automatic rewrite must not leave a truncated rewrite selected', async () => {
  const h = await typeDuringRewrite();
  assert.notEqual(h.last().mes, partial, 'the reply the user is answering is not replaced by a stopped fragment');
});

test('a cancelled automatic rewrite is not accepted, badged "rerolled" or checked again', async () => {
  const h = await typeDuringRewrite();
  const rewrite = Object.values<any>(h.controller.record.attempts).find(attempt => attempt.rerolledByCheck);
  assert.ok(rewrite);
  assert.equal(rewrite.status, 'cancelled', 'the cancelled writer attempt stays cancelled (the phase 3 unit test expects this too)');
  assert.equal(h.checks().length, 1, 'no reply-check request for a cancelled fragment');
});
