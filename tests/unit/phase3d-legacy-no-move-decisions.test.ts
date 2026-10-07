/**
 * Item 12 on records written before 3c. compactRecord (state.ts:400) deletes
 * stageRecords of every attempt whose decision stages did not fail, on every
 * persist, so a completed no-move turn keeps no move answer. The only other
 * no-move evidence macroState reads is `decisionsApplied`, which 0.7.x and
 * 0.8 phase 1-3b records never had. Correct: a wording swipe of an old judged
 * no-move reply still reports module::decisions "true", so a preset's
 * {{if !{{director::module::decisions}}}} fallback dice stay off.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, scriptJudge, choice } from './support/test-host.ts';

test('review3c: a swipe of a pre-3c judged no-move reply keeps module::decisions true', async t => {
  const { host, controller } = await harness();
  t.after(() => controller.destroy());
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false, pacing: false, replyCheck: false };
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('default');
  scriptJudge(controller, { move: choice('NONE'), move_count: choice('one') });
  host.context.generate = async () => {
    host.chat().push({ name: 'Player', is_user: true, is_system: false, mes: host.composerValue }); host.composerValue = '';
    await controller.interceptor(structuredClone(host.chat()), 4096, () => assert.fail('unexpected abort'), 'normal');
    host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: 'The guide nods.', swipe_id: 0, swipes: ['The guide nods.'], swipe_info: [{ extra: {} }] });
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal');
  };
  host.composerValue = 'I greet the guide.';
  await controller.directorSend();
  await (controller as any).waitForMessageTasks();

  // The same record as 0.8 phase 3b saved it: no decisionsApplied field.
  for (const attempt of Object.values<any>(controller.record!.attempts)) delete attempt.decisionsApplied;
  await (controller as any).persist();
  await controller.loadChat();
  const source = Object.values<any>(controller.record!.attempts).at(-1);
  assert.equal(source.resolutionId ?? null, null, 'sanity: a no-move turn has no ruling');
  assert.ok(!source.judgeFailedStages?.includes('move'), 'sanity: the judge did not fail');
  assert.equal(source.stageRecords, undefined, 'sanity: compaction already removed the move answer');

  await controller.interceptor([], 4096, () => assert.fail('unexpected abort'), 'swipe');
  assert.equal(controller.getMacro('module::decisions'), 'true',
    'the frozen no-move decision reaches this wording swipe; fallback dice must stay off');
});
