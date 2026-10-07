/**
 * Item 19 renamed the 1:1 pacing-only request from stage 'speaker' to 'pacing'
 * (staged.ts:240). Replay matches saved answers by stage name
 * (evaluateStageWithReplay, staged.ts:131), and records written before 3c
 * saved that request as 'speaker'. "Try the judge again" on such a turn then
 * re-asks the pacing questions (a paid request) and may change the frozen
 * scene and hand-back, although only the move stage failed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, scriptJudge, choice } from './support/test-host.ts';

test('review3c: retrying a pre-3c 1:1 turn replays its successful pacing answers', async t => {
  const { host, controller } = await harness();
  t.after(() => controller.destroy());
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false, pacing: true, replyCheck: false };
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('default');
  // Pacing answers; the move request gets no valid answer (a failed decision stage).
  const requests = scriptJudge(controller, { scene: choice('conversation'), hand_back: choice('CONTINUE') });
  host.context.generate = async () => {
    if (host.composerValue) { host.chat().push({ name: 'Player', is_user: true, is_system: false, mes: host.composerValue }); host.composerValue = ''; }
    await controller.interceptor(structuredClone(host.chat()), 4096, () => {}, 'normal');
    host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: 'The guide waits.', swipe_id: 0, swipes: ['The guide waits.'], swipe_info: [{ extra: {} }] });
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal');
  };
  host.composerValue = 'I nod. "Open the gate, please."';
  await controller.directorSend();
  await (controller as any).waitForMessageTasks();
  const source = Object.values<any>(controller.record!.attempts).at(-1);
  assert.ok(source.judgeFailedStages.includes('move'), 'sanity: the move stage failed, so Retry is offered');
  const pacingRecord = source.stageRecords.find((record: any) => 'scene' in record.questions);
  assert.ok(pacingRecord, 'sanity: the successful pacing request is kept for replay');
  pacingRecord.stage = 'speaker'; // as 0.8 phase 1-3b saved the 1:1 pacing-only request
  await (controller as any).persist();
  await controller.loadChat();

  const before = requests.filter(request => 'scene' in request.questions).length;
  await controller.retryJudge();
  const after = requests.filter(request => 'scene' in request.questions).length;
  assert.equal(after - before, 0, 'the scene and hand-back answers are replayed, not asked again');
});
