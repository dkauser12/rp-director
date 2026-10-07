/** Harness sanity: the verified-sound happy path of C2 on the ST-faithful harness. */
import { test } from 'node:test';
import { rc, score, until, attempts, assert } from './support/phase3c-replycheck.ts';

for (const streaming of [true, false]) test(`baseline (${streaming ? 'streaming' : 'non-streaming'}): one automatic wording retry, same draw, correction in the tail block only`, async () => {
  const h = await rc({ streaming, outMs: 5, inMs: 5, saveLatencyMs: 5,
    answers: (request, i) => ('speaks_for_user' in request.questions ? { speaks_for_user: score(4) } : {}) });
  const prompts: { type: string; chat: string[] }[] = [];
  const interceptor = h.controller.interceptor.bind(h.controller);
  h.controller.interceptor = async (chat: any[], size: number, abort: (i: boolean) => void, type: string) => {
    await interceptor(chat, size, abort, type);
    prompts.push({ type, chat: chat.map(m => String(m.mes)) });
  };
  await h.sim.clickSend('I nod. "Open the gate, please."');
  await until(() => h.checks().length === 2, 'two checks');
  await h.sim.settle();
  const last = h.last();
  assert.equal(last.swipes.length, 2, 'exactly one automatic swipe');
  assert.equal(last.swipe_id, 1);
  const list = attempts(h.sim);
  assert.deepEqual(list, ['normal/ruled:accepted', 'swipe/ruled:accepted']);
  const [a, b] = Object.values<any>(h.controller.record.attempts).sort((x, y) => x.createdAt - y.createdAt);
  assert.equal(a.resolutionId, b.resolutionId, 'same frozen ruling');
  assert.equal(Object.keys(h.controller.record.resolutions).length, 1, 'no new draw');
  assert.equal(b.rerolledByCheck, 'writes for {{user}}');
  assert.equal(h.popups.length, 0);
  // Same tools/tool_choice and chat; the correction is in the unscanned tail block.
  const [first, second] = h.sim.envelopes as any[];
  assert.equal(second.type, 'swipe');
  assert.deepEqual(second.envelope, first.envelope);
  const [p1, p2] = prompts;
  assert.deepEqual(p2!.chat, p1!.chat);
  assert.match(second.injection, /\(OOC: Rewrite the reply/);
  assert.doesNotMatch(first.injection, /\(OOC:/);
  assert.doesNotMatch(JSON.stringify(h.host.chat().map((message: any) => [message.mes, message.swipes])), /\(OOC:/);
  console.log(h.sim.log.join(' | '));
});
