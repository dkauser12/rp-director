/**
 * C2 cancellation. In SillyTavern, swipe() awaits the generation and then more
 * I/O (endSwipe: saveChatConditional, updateSwipeCounter; script.js:10039-10058)
 * AFTER MESSAGE_RECEIVED. The Director's completion runs on a setTimeout(0), so the
 * corrected reply's completion can call scheduleReplyCheck -> cancelReplyCheck()
 * while automaticReply is still set. That records cancelledReplySwipe for the
 * finished automatic swipe and nothing ever clears it.
 * Correct behaviour: a later, user-initiated swipe that happens to land on the same
 * swipe index (after the user deletes the corrected swipe) must generate.
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

test('C2: a stale cancelledReplySwipe does not abort a later user swipe at the same index', async t => {
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
  const aborts: string[] = [];
  let swipes = 0;
  host.context.swipe.right = async () => {
    swipes++;
    const message = host.chat().at(-1)!;
    message.swipe_id = message.swipes!.length;
    await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
    let aborted = false;
    await controller.interceptor(structuredClone(host.chat().slice(0, -1)), 4096, () => { aborted = true; }, 'swipe');
    if (aborted) { aborts.push(`swipe ${swipes}`); message.swipe_id = message.swipes!.length - 1; message.mes = message.swipes!.at(-1)!; return; }
    message.mes = `Replacement ${swipes}.`;
    message.swipes!.push(message.mes);
    message.swipe_info!.push({ extra: {} });
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'swipe');
    await host.emit('GENERATION_ENDED');
    // endSwipe(): ST awaits the generation, then saveChatConditional / updateSwipeCounter I/O.
    await new Promise(resolve => setTimeout(resolve, 25));
  };
  host.composerValue = 'I offer the guide a fair payment to open the gate.';
  await controller.directorSend();
  await until(() => Object.values(controller.record!.attempts).filter(attempt => attempt.replyCheck).length === 2);
  assert.equal(swipes, 1, 'sanity: exactly one automatic correction ran');
  assert.equal(aborts.length, 0, 'sanity: the automatic correction itself was not aborted');
  // The user deletes the corrected swipe (index 1)...
  const message = host.chat().at(-1)!;
  message.swipes!.splice(1, 1); message.swipe_info!.splice(1, 1); message.swipe_id = 0; message.mes = message.swipes![0]!;
  await host.emit('MESSAGE_SWIPE_DELETED', host.chat().length - 1);
  // ...and swipes right for a fresh wording, which lands on index 1 again.
  host.swipeResult = async () => 'reuse';
  await host.context.swipe.right();
  assert.deepEqual(aborts, [], 'the user swipe must generate, not be silently aborted by a stale automatic-swipe marker');
});
