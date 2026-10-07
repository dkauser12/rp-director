/**
 * Item 19 in a group chat. The speaker question and the pacing questions share
 * one request, still labelled 'speaker' (staged.ts:240), and a validation error
 * is reported per request stage. An invalid scene/hand-back answer therefore
 * toasts "Judge unavailable (speaker)", records 'speaker' as failed although the
 * speaker answer was valid, reads module::speaker as "" and makes "Try the judge
 * again" re-judge the speaker (controller.ts:976).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, scriptJudge, choice, writerReplies } from './support/test-host.ts';
import { actorIdFor } from '../../src/identity.ts';

test('review3c: a group pacing failure is reported as pacing, and the valid speaker stays applied', async t => {
  const { host, controller } = await harness({ group: true });
  t.after(() => controller.destroy());
  controller.settings.modules = { speaker: true, decisions: true, meters: false, secrets: false, lore: false, pacing: true, replyCheck: false };
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('default');
  // Valid speaker and move answers; the scene and hand-back answers are missing.
  scriptJudge(controller, { speaker: choice(actorIdFor('Guide', 'guide.png')), move: choice('NONE'), move_count: choice('one') });
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide waits.');
  const intercept = controller.interceptor.bind(controller);
  let speakerReader = '';
  controller.interceptor = async (...args: Parameters<typeof controller.interceptor>) => { await intercept(...args); speakerReader = controller.getMacro('module::speaker'); };
  host.composerValue = 'I wait by the gate.';
  await controller.directorSend();
  const attempt = Object.values(controller.record!.attempts).at(-1)!;
  assert.equal(attempt.frozenSpeaker?.selected, actorIdFor('Guide', 'guide.png'), 'sanity: the judged speaker was applied');
  assert.ok(host.notices.some(text => /Judge unavailable/.test(text)), 'sanity: the pacing failure was reported');
  assert.ok(!host.notices.some(text => /\(speaker\)/.test(text)), `reported as: ${host.notices.join(' | ')}`);
  assert.equal(speakerReader, 'true', 'the speaker decision reached this generation');
});
