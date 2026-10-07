/**
 * Native Regenerate (Ctrl+Enter, /regenerate fallbacks, group paths) of a ruled reply.
 *
 * 3c asks Keep / Roll again at GENERATION_STARTED (script.js 4299), before
 * Generate() deletes the reply (4407-4411). When Roll again fails there (Threshold
 * method or a Reassess: the judge is down, times out, or "This turn is too old to
 * reassess"), confirmRetry() returns false and onGenerationStarted() returns
 * without approving. SillyTavern still deletes the reply and runs the
 * interceptors (4564), where prepareGeneration() asks the same question a second
 * time and, if that also fails, calls abort(true): the reply and all its swipes
 * are gone and nothing is generated.
 *
 * GENERATION_STARTED cannot cancel a native regenerate, so a failed Roll again
 * there must fall back to Keep, and the interceptor must never abort a
 * regenerate after SillyTavern deleted the reply.
 */
import { test } from 'node:test';
import { sim2, assert } from './support/phase3b-workflow.ts';

async function ruledThresholdReply() {
  const sim: any = await sim2();
  sim.controller.profile.resolutionMethod = 'threshold';
  const base = sim.controller.provider.bind(sim.controller);
  const judge = { down: false };
  sim.controller.provider = () => {
    const provider = base();
    return { ...provider, evaluate: async (request: any, signal: AbortSignal) => {
      if (judge.down) throw new Error('network: the judge is unreachable');
      return provider.evaluate(request, signal);
    } };
  };
  await sim.clickSend('I nod. "Open the gate, please."');
  const reply = sim.host.chat().at(-1);
  assert.equal(reply.is_user, false, 'sanity: a reply exists');
  assert.ok(Object.values<any>(sim.controller.record.resolutions).some(r => r.method === 'threshold'), 'sanity: the reply is ruled by threshold');
  sim.controller.settings.askWhenSwiping = true;
  return { sim, judge, reply };
}

test('a native Regenerate whose Roll again fails twice must not delete the reply without writing one', async () => {
  const { sim, judge } = await ruledThresholdReply();
  let asked = 0;
  sim.host.swipeResult = async () => { asked++; return 'reroll'; };
  judge.down = true;
  await sim.ctrlEnter();
  console.log(`asked ${asked}; chat ends with`, sim.host.chat().at(-1).is_user ? 'the user message' : 'a reply', '|', sim.log.slice(-5).join(' | '));
  assert.equal(sim.host.chat().at(-1).is_user, false, 'after Regenerate the chat still ends with a reply');
  // Phase 3d (item 8): the failed Roll again falls back to Keep, told in one sentence.
  const notices: string[] = sim.host.notices;
  assert.deepEqual(notices.filter(notice => notice.includes('roll again') || notice.startsWith('Decision unchanged')),
    ['The judge could not roll again, so the reply keeps its result.']);
  const written = Object.values<any>(sim.controller.record.attempts).filter(attempt => attempt.generationType === 'regenerate');
  const first = Object.values<any>(sim.controller.record.attempts).find(attempt => attempt.generationType === 'normal');
  assert.equal(written.at(-1)?.resolutionId, first?.resolutionId, 'the regenerated reply keeps the frozen result');
});

test('a native Regenerate asks Keep / Roll again once, even when Roll again fails', async () => {
  const { sim, judge } = await ruledThresholdReply();
  const answers: ('reroll' | 'reuse')[] = ['reroll', 'reuse'];
  let asked = 0;
  sim.host.swipeResult = async () => { asked++; return answers.shift() ?? 'reuse'; };
  judge.down = true;
  await sim.ctrlEnter();
  console.log(`asked ${asked} |`, sim.log.slice(-5).join(' | '));
  assert.equal(sim.host.chat().at(-1).is_user, false, 'sanity: the reply was regenerated');
  assert.equal(asked, 1, 'the choice is offered once per Regenerate');
});
