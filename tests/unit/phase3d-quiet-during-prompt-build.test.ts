/**
 * Phase 3d follow-up (latent since early phases). SillyTavern builds the main
 * prompt after the interceptors (script.js 4564), with awaits in between: the
 * World Info scan and its events (WORLDINFO_ENTRIES_LOADED, WORLD_INFO_ACTIVATED,
 * WORLDINFO_SCAN_DONE), then GENERATE_BEFORE_COMBINE_PROMPTS and
 * GENERATE_AFTER_COMBINE_PROMPTS (5234-5243). Only then does prepareOpenAIMessages
 * read the in-chat extension prompts (openai.js 856).
 *
 * An extension that awaits a quiet generation from one of those listeners runs the
 * quiet generation's GENERATION_STARTED, its interceptor, GENERATE_AFTER_DATA and,
 * because its unblockGeneration() hides the stop button the main generation showed
 * (script.js 3532-3537, 5693-5701), GENERATION_ENDED, all inside that window.
 * The Director cleared its block for the quiet prompt and never put it back, and
 * the quiet generation's end ran the Director generation's end cleanup: the main
 * prompt of a ruled turn was written without its ruling.
 */
import { test } from 'node:test';
import { sim2, assert } from './support/phase3b-workflow.ts';
import { rc, score, until } from './support/phase3c-replycheck.ts';

const RULING = '[Director ruling — binding for this reply]';

/**
 * After the matching generation's interceptor, another extension awaits one quiet
 * generation. `built: false`: it ends before its data is built (a failed request).
 * `meanwhile` runs while the quiet prompt is being built.
 */
function quietAfterInterceptor(sim: any, type: string, options: { built?: boolean; meanwhile?: () => Promise<void> } = {}) {
  const intercept = sim.controller.interceptor.bind(sim.controller);
  const quietPrompts: string[] = [];
  sim.controller.interceptor = async (chat: unknown, size: number, abort: (immediately: boolean) => void, generationType: string) => {
    await intercept(chat, size, abort, generationType);
    if (generationType !== type || quietPrompts.length) return;
    await sim.host.emit('GENERATION_STARTED', 'quiet', { quiet_prompt: 'Summarize the scene.' }, false);
    await intercept([], size, () => {}, 'quiet');
    quietPrompts.push(sim.host.injection); // what the quiet prompt reads
    await options.meanwhile?.();
    if (options.built !== false) await sim.host.emit('GENERATE_AFTER_DATA', {}, false);
    await sim.host.emit('GENERATION_ENDED', sim.host.chat().length);
  };
  return quietPrompts;
}

test('phase3d: a quiet generation awaited while the main prompt is built leaves the ruling in the main prompt', async t => {
  const sim: any = await sim2();
  t.after(() => sim.controller.destroy());
  const quiet = quietAfterInterceptor(sim, 'normal');
  await sim.clickSend('I nod. "Open the gate, please."');
  const main = sim.envelopes.find((envelope: any) => envelope.type === 'normal' && envelope.depth === 0);
  assert.equal(quiet.length, 1, 'sanity: the quiet generation ran');
  assert.equal(quiet[0], '', 'the quiet prompt carries no Director block');
  assert.ok(main?.injection.includes(RULING), `the main prompt still carries its ruling: ${JSON.stringify(main?.injection)}`);
  const written = Object.values<any>(sim.controller.record.attempts).at(-1);
  assert.equal(written.status, 'accepted', 'the ruled reply completes as usual');
  assert.ok(written.resolutionId, 'with its ruling');
});

test('phase3d: a quiet generation while the rewrite prompt is built gets neither the block nor the correction', async t => {
  const h: any = await rc({ answers: (request: any) => ('speaks_for_user' in request.questions ? { speaks_for_user: score(4) } : {}) });
  t.after(() => h.controller.destroy());
  const quiet = quietAfterInterceptor(h.sim, 'swipe');
  await h.sim.clickSend('I nod. "Open the gate, please."');
  await until(() => h.checks().length === 2, 'the rewrite and its check');
  await h.sim.settle();
  const rewrite = h.sim.envelopes.find((envelope: any) => envelope.type === 'swipe');
  assert.equal(quiet.length, 1, 'sanity: the quiet generation ran');
  assert.doesNotMatch(quiet[0]!, /\(OOC:|Director ruling/, 'the quiet prompt carries neither the block nor the correction');
  assert.match(rewrite?.injection ?? '', /\(OOC: Rewrite the reply/, 'the rewrite prompt keeps its correction');
  assert.ok(rewrite?.injection.includes(RULING), 'and its ruling');
  assert.ok(Object.values<any>(h.controller.record.attempts).some(attempt => attempt.rerolledByCheck && attempt.status === 'accepted'),
    'the rewrite completes as usual');
});

test('phase3d: a quiet generation that ends before its data is built puts the block back too', async t => {
  const sim: any = await sim2();
  t.after(() => sim.controller.destroy());
  const quiet = quietAfterInterceptor(sim, 'normal', { built: false });
  await sim.clickSend('I nod. "Open the gate, please."');
  const main = sim.envelopes.find((envelope: any) => envelope.type === 'normal' && envelope.depth === 0);
  assert.equal(quiet[0], '', 'the quiet prompt carries no Director block');
  assert.ok(main?.injection.includes(RULING), 'the main prompt still carries its ruling');
});

test('phase3d: a block the Director changed during the quiet generation is not put back', async t => {
  const sim: any = await sim2();
  t.after(() => sim.controller.destroy());
  // The user pauses the Director in this chat while the quiet prompt is built.
  quietAfterInterceptor(sim, 'normal', { meanwhile: () => sim.controller.setPaused(true) });
  await sim.clickSend('I nod. "Open the gate, please."');
  const main = sim.envelopes.find((envelope: any) => envelope.type === 'normal' && envelope.depth === 0);
  assert.equal(sim.controller.record.paused, true, 'sanity: paused');
  assert.equal(main?.injection, '', 'the old ruling is not restored over the paused Director');
});
