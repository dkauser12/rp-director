/**
 * C2/C3 interceptor wrapper. interceptor() appends the automatic correction to the
 * prompt copy whenever currentAttemptId has replyCorrection, for ANY generation type.
 * Other extensions' quiet generations (Summarize, Expressions LLM mode) run from
 * MESSAGE_RECEIVED handlers, i.e. before the Director's deferred completion clears
 * currentAttemptId. Correct behaviour: only the automatic wording swipe gets the OOC
 * correction; a 'quiet' prompt copy is left untouched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../../src/controller.ts';
import type { Answer } from '../../src/types.ts';
import { actorIdFor } from '../../src/identity.ts';
import { TestHost, choice, noul, scriptJudge } from './support/test-host.ts';

const score = (value: number): Answer => ({ type: 'score', score: value, probabilities: null, legend: {}, confidence: null, provenance: 'fixture' } as Answer);
async function until(predicate: () => boolean) {
  for (let i = 0; i < 300 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(predicate(), 'expected asynchronous boundary');
}

test('C2: a quiet generation during the corrected reply does not receive the OOC correction', async t => {
  const host = new TestHost();
  const controller = new Controller(host);
  await controller.init();
  t.after(() => controller.destroy());
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false, pacing: false, replyCheck: true };
  controller.settings.reactions.enabled = false;
  controller.profile.resolutionMethod = 'sample';
  await controller.setChatPack('default');
  scriptJudge(controller, { move: choice('s1'), move_count: choice('one'), owner: choice('player'), target: choice(actorIdFor('Guide', 'guide.png')),
    family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'), ruling: noul(0.45),
    speaks_for_user: score(4), responds: score(2), repeats: score(0), follows_ruling: noul(1) });
  host.context.generate = async () => {
    host.chat().push({ name: 'Player', is_user: true, is_system: false, mes: host.composerValue }); host.composerValue = '';
    await controller.interceptor(structuredClone(host.chat()), 4096, () => assert.fail('unexpected abort'), 'normal');
    const text = 'The guide says you agree.';
    host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }] });
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal');
  };
  let quietPrompt: { is_user: boolean; mes: string }[] | null = null;
  let swipeCopy: { is_user: boolean; mes: string }[] | null = null;
  let swipeInjection = '', quietInjection = '';
  host.context.swipe.right = async () => {
    const message = host.chat().at(-1)!;
    message.swipe_id = message.swipes!.length;
    await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
    swipeCopy = structuredClone(host.chat().slice(0, -1));
    await controller.interceptor(swipeCopy, 4096, () => assert.fail('unexpected abort'), 'swipe');
    swipeInjection = host.injection;
    message.mes = 'Replacement.'; message.swipes!.push(message.mes); message.swipe_info!.push({ extra: {} });
    // Another extension's MESSAGE_RECEIVED handler starts a quiet generation (e.g. a summary).
    quietPrompt = structuredClone(host.chat());
    await controller.interceptor(quietPrompt, 4096, () => {}, 'quiet');
    quietInjection = host.injection;
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'swipe');
    await host.emit('GENERATION_ENDED');
  };
  host.composerValue = 'I offer the guide a fair payment to open the gate.';
  await controller.directorSend();
  await until(() => quietPrompt !== null);
  assert.match(swipeInjection, /\(OOC: Rewrite the reply/, 'the automatic swipe carries the correction at depth 0');
  assert.doesNotMatch(JSON.stringify(swipeCopy), /\(OOC:/, 'correction never enters the World Info scan chat');
  assert.doesNotMatch(quietInjection, /\(OOC:/, 'quiet prompts receive no correction block');
  assert.doesNotMatch(JSON.stringify(quietPrompt), /\(OOC:/, 'a quiet generation by another extension must not get the correction');
});
