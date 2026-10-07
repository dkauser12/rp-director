/**
 * prepareGeneration() recognises the automatic rewrite only when attemptAt()
 * returns the checked attempt (`automaticReply.sourceId === source.attemptId`,
 * controller.ts ~1843). During the rewrite's swipe the message's swipe_id is the
 * new slot, so attemptAt() skips the marker and picks the attempt holding the
 * cursor's ACTIVE (latest-generation) ruling. When the checked reply carries an
 * older ruling (a Roll again made another wording, then the user went back to the
 * first wording and continued it), the rewrite is written under the other ruling,
 * without the correction, and is not recorded as a rewrite. automatic.attemptId
 * stays null, so the rewrite's lifecycle (finished/cancel/discard) never binds.
 *
 * C2: the rewrite swipes "with an OOC correction ..., the frozen ruling unchanged".
 */
import { test } from 'node:test';
import { rc, score, until, assert } from './support/phase3c-replycheck.ts';

test('the automatic rewrite keeps the checked reply\'s ruling and carries the correction', async t => {
  let checks = 0;
  const h = await rc({ answers: request => ('speaks_for_user' in request.questions ? { speaks_for_user: score(++checks === 3 ? 4 : 0) } : {}) });
  t.after(() => h.controller.destroy());
  await h.sim.clickSend('I nod. "Open the gate, please."');
  await until(() => h.checks().length === 1, 'check 1');
  await h.sim.settle();
  const first = Object.values<any>(h.controller.record.attempts)[0];
  assert.ok(first.resolutionId, 'sanity: the first wording is ruled');
  assert.equal(await h.controller.reroll(true), true, 'sanity: Roll again made a second wording');
  await until(() => h.checks().length === 2, 'check 2');
  await h.sim.settle();
  await h.sim.swipeLeft(); await h.sim.settle();
  assert.equal(h.last().swipe_id, 0, 'sanity: back on the first wording');
  const injections: string[] = [];
  const interceptor = h.controller.interceptor.bind(h.controller);
  h.controller.interceptor = async (chat: unknown, size: number, abort: (i: boolean) => void, type: string) => {
    await interceptor(chat, size, abort, type);
    if (type === 'swipe') injections.push(h.host.injection);
  };
  await h.sim.generate('continue'); // continue the first wording; its check asks for a rewrite
  await until(() => h.checks().length === 3, 'check 3');
  await until(() => injections.length === 1, 'the rewrite reached the writer');
  await h.sim.settle();
  const continued = Object.values<any>(h.controller.record.attempts).find(a => a.generationType === 'continue');
  const rewrite = Object.values<any>(h.controller.record.attempts).at(-1);
  console.log(`checked ruling ${continued.resolutionId === first.resolutionId ? 'first' : 'other'}; rewrite ruling ${rewrite.resolutionId === continued.resolutionId ? 'same' : 'different'}; correction ${/\(OOC:/.test(injections[0]!)}`);
  assert.equal(continued.resolutionId, first.resolutionId, 'sanity: the continued wording kept its own ruling');
  assert.match(injections[0]!, /\(OOC:/, 'the rewrite carries the correction');
  assert.equal(rewrite.rerolledByCheck, 'writes for {{user}}', 'the rewrite is recorded as the automatic rewrite');
  assert.equal(rewrite.resolutionId, continued.resolutionId, 'the frozen ruling of the checked reply is unchanged');
});
