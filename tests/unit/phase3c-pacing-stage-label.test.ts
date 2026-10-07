/**
 * C1. Scene/hand-back ride in the request labelled stage 'speaker' (staged.ts:240).
 * In a 1:1 chat there is no speaker question, yet a failed pacing request is reported
 * as "Judge unavailable (speaker)" and recorded as the failed stage 'speaker'.
 * Correct behaviour: the failure names pacing (the thing that actually failed).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, writerReplies } from './support/test-host.ts';

test('C1: a failed pacing-only request in a 1:1 chat is not reported as a speaker failure', async t => {
  const { host, controller } = await harness();
  t.after(() => controller.destroy());
  controller.settings.modules = { speaker: true, decisions: false, meters: false, secrets: false, lore: false, pacing: true, replyCheck: false };
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('default');
  const base = controller.provider();
  controller.provider = () => ({ ...base, evaluate: async request => {
    if ('scene' in request.questions) throw new Error('Connection lost.');
    return base.evaluate(request, new AbortController().signal);
  } });
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide waits.');
  host.composerValue = 'I wait.';
  await controller.directorSend();
  const attempt = Object.values(controller.record!.attempts).at(-1)!;
  assert.ok(host.notices.some(text => /Judge unavailable/.test(text)), 'sanity: the failure was reported');
  assert.ok(!host.notices.some(text => /\(speaker\)/.test(text)), `no speaker question was asked: ${host.notices.join(' | ')}`);
  assert.ok(!attempt.judgeFailedStages?.includes('speaker'), `failed stages: ${attempt.judgeFailedStages}`);
});
