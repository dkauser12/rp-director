/**
 * Item 3 (dry runs). The dry-run strip/restore (controller.ts:1928-1934, 292-298)
 * restores attempt.injectedText, not the injection that was live. In the
 * rewrite's closed-tool follow-up the live injection is the continuation text
 * (injectedText + "[Director tool result] … do not call it again",
 * controller.ts:1488); a dry run in that window silently drops the tool notice
 * from the follow-up prompt.
 */
import { test } from 'node:test';
import { rc, score, until, assert } from './support/phase3c-replycheck.ts';

const puppet = (request: any) => 'speaks_for_user' in request.questions ? { speaks_for_user: score(4) } : {};

test('review3c: a dry run during the rewrite\'s tool follow-up restores the live injection', async t => {
  const h = await rc({ answers: puppet });
  t.after(() => h.controller.destroy());
  h.sim.writer = [{ text: 'Player agrees to follow the guide.' }, { tool: 'auto' }, { text: 'The guide waits.' }];
  const intercept = h.controller.interceptor.bind(h.controller);
  let live = '';
  h.controller.interceptor = async (...args: any[]) => {
    const followUp = Boolean((h.controller as any).toolContinuation);
    await intercept(...args);
    if (!followUp) return;
    live = h.host.injection;
    // e.g. another extension's token count runs while the follow-up prompt is assembled
    await h.host.emit('GENERATION_STARTED', 'normal', {}, true);
    await h.host.emit('GENERATE_AFTER_DATA', {}, true);
  };
  await h.sim.clickSend('I ask the guide to open the gate.');
  await until(() => live !== '', 'the rewrite\'s closed-tool follow-up');
  await h.sim.settle();
  assert.match(live, /\[Director tool result\]/, 'sanity: the follow-up carries the tool notice');
  const followUp = (h.sim.envelopes as any[]).find(envelope => envelope.depth === 1);
  assert.equal(followUp?.injection, live, 'the follow-up prompt gets the injection that was live before the dry run');
});
