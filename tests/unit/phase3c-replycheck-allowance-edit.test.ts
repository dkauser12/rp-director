/**
 * The per-turn allowance is keyed by a transcript cursor (controller.ts 1960:
 * cursorOf(prefix up to the latest user message)). Every cursor hashes all
 * earlier messages, so editing ANY earlier message (a typo in the greeting) gives
 * the same user turn a fresh key and re-arms the automatic rewrite. Same root as
 * known item 1 (cursor rebase on edits); its fix must also rebase replyCheckRerolls.
 */
import { test } from 'node:test';
import { rc, score, until, assert } from './support/phase3c-replycheck.ts';

test('editing an earlier message does not grant the same user turn a second automatic rewrite', async () => {
  const h = await rc({ answers: request => ('speaks_for_user' in request.questions ? { speaks_for_user: score(4) } : {}) });
  await h.sim.clickSend('I nod. "Open the gate, please."');
  await until(() => h.checks().length === 2, 'original + rewrite checked');
  await h.sim.settle();
  const rewrites = () => Object.values<any>(h.controller.record.attempts).filter(a => a.rerolledByCheck).length;
  assert.equal(rewrites(), 1);
  // Fix a typo in the greeting (message 1), then ask for another wording of the latest reply.
  h.host.chat()[1].mes = 'The gate remains shut. "State your business, or wait until dawn!"';
  await h.host.emit('MESSAGE_EDITED', 1);
  await h.sim.swipeRight();
  await until(() => h.checks().length >= 3, 'the manual swipe is checked');
  await h.sim.settle();
  console.log(`automatic rewrites for one user turn: ${rewrites()}; swipes: ${h.last().swipes.length}; allowance keys: ${h.controller.record.replyCheckRerolls.length}`);
  assert.equal(rewrites(), 1, 'still one automatic rewrite for this user turn');
});
