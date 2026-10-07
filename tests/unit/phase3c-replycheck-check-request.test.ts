/** Reply-check request budgets, stage-specific recovery and independent answers. */
import { test } from 'node:test';
import { rc, score, until, assert } from './support/phase3c-replycheck.ts';

test('long replies: the check trims older context instead of failing every turn', async () => {
  const h = await rc({ answers: request => ('speaks_for_user' in request.questions ? { speaks_for_user: score(0) } : {}) });
  const long = (n: number) => (`Reply ${n}. ` + 'The rain keeps falling on the old stone road while the guide talks. '.repeat(160)).trimEnd(); // ~10.9k chars
  const chat = h.host.chat();
  for (let n = 1; n <= 5; n++) {
    chat.push({ name: 'Player', is_user: true, is_system: false, mes: `I keep walking (${n}).` });
    chat.push({ name: 'Guide', is_user: false, is_system: false, mes: long(n), swipe_id: 0, swipes: [long(n)], swipe_info: [{ extra: {} }], extra: {} });
  }
  h.sim.writer = [{ text: long(6) }];
  await h.sim.clickSend('I nod. "Open the gate, please."');
  await h.sim.settle();
  const attempt = Object.values<any>(h.controller.record.attempts).at(-1);
  assert.equal(h.checks().length, 1, 'the check is still requested');
  assert.ok(attempt.replyCheck && !attempt.replyCheckError, 'a result, not "Reply check unavailable"');
  const state = h.checks()[0].snapshot.state;
  assert.ok(JSON.stringify(state).length <= 60_000, 'the request fits the character budget');
  assert.deepEqual(state.previous_replies.map((reply: any) => reply.text), [long(2), long(3), long(4), long(5)], 'only the oldest comparison reply was removed');
  assert.equal(state.reply.text, long(6), 'the complete reply is still checked');
  assert.equal(state.latest_input, 'I nod. "Open the gate, please."', 'the latest user input is preserved');
});

test('W2: a reply-check failure toasts once until the reply-check stage recovers', async () => {
  let failCheck = true;
  const h = await rc({ answers: request => {
    if (!('speaks_for_user' in request.questions)) return {};
    if (failCheck) throw new Error('Reply-check request failed in the fixture');
    return { speaks_for_user: score(0) };
  } });
  h.sim.writer = Array.from({ length: 5 }, (_, index) => ({ text: `The guide waits by the gate. Reply ${index + 1}.` }));
  for (const text of ['I nod. "Open the gate, please."', 'I wait. "Open it now."', 'I sigh. "Please open it."']) { await h.sim.clickSend(text); await h.sim.settle(); }
  const toasts = () => h.host.notices.filter((notice: string) => notice.startsWith('Reply check unavailable'));
  assert.equal(h.checks().length, 3, 'all three checks were attempted');
  assert.equal(toasts().length, 1, 'successful decision stages do not clear a reply-check failure');
  failCheck = false;
  await h.sim.clickSend('I ask. "Can you open it?"'); await h.sim.settle();
  assert.ok(Object.values<any>(h.controller.record.attempts).at(-1).replyCheck, 'the reply-check stage recovered');
  failCheck = true;
  await h.sim.clickSend('I insist. "Open the gate."'); await h.sim.settle();
  assert.equal(toasts().length, 2, 'a new reply-check failure can notify after that stage recovered');
});

test('one unresolved answer does not discard a valid "writes for {{user}}" verdict', async () => {
  const h = await rc({ answers: request => ('speaks_for_user' in request.questions
    ? { speaks_for_user: score(4), repeats: { type: 'score', score: 9, legend: {}, probabilities: null, confidence: null, provenance: 'fixture' } } : {}) });
  await h.sim.clickSend('I nod. "Open the gate, please."');
  await until(() => h.checks().length >= 1, 'the check');
  await h.sim.settle();
  const first = Object.values<any>(h.controller.record.attempts).sort((a, b) => a.createdAt - b.createdAt)[0];
  assert.equal(first.replyCheck?.speaksForUser, 4, 'the valid score is kept');
  assert.equal(first.replyCheck?.repeats, null, 'the invalid score is discarded');
  assert.equal(h.last().swipes.length, 2, 'the correction still runs');
});
