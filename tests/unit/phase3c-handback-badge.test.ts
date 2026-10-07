/**
 * C5 badge. The badge label says "your turn at the next beat" whenever the frozen
 * decision was HAND_BACK, even on a swipe where the hand-back instruction was
 * suppressed (switch off, or Pacing off). The badge describes that reply, so it
 * should only claim a hand-back the writer was actually given.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, scriptJudge, writerReplies, choice } from './support/test-host.ts';
import { workflowBadgeLabel } from '../../src/workflow-badge.ts';

for (const disabled of ['handBack', 'pacing']) test(`C5: a swipe with ${disabled} off does not claim a hand-back`, async t => {
  const { host, controller } = await harness();
  t.after(() => controller.destroy());
  controller.settings.modules = { speaker: false, decisions: false, meters: false, secrets: false, lore: false, pacing: true, replyCheck: false };
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('default');
  scriptJudge(controller, { scene: choice('conversation'), hand_back: choice('HAND_BACK') });
  writerReplies(host, controller, 'Guide', 'guide.png', 'Which path will you take?');
  host.composerValue = 'Show me the paths.';
  await controller.directorSend();
  await new Promise(resolve => setTimeout(resolve, 10));
  const id = host.chat().length - 1;
  assert.match(workflowBadgeLabel(host.readWorkflowBadge(id)!), /your turn at the next beat/, 'sanity: the Send was handed back');
  if (disabled === 'handBack') controller.settings.handBackBeats = false;
  else controller.settings.modules.pacing = false;
  const message = host.chat()[id]!;
  message.swipe_id = message.swipes!.length;
  await controller.interceptor(structuredClone(host.chat().slice(0, -1)), 4096, () => assert.fail('unexpected abort'), 'swipe');
  assert.doesNotMatch(host.injection, /Director hand-back/, 'sanity: the writer got no hand-back');
  message.mes = 'The guide keeps talking.'; message.swipes!.push(message.mes); message.swipe_info!.push({ extra: {} });
  await host.emit('MESSAGE_RECEIVED', id, 'swipe');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.doesNotMatch(workflowBadgeLabel(host.readWorkflowBadge(id)!), /your turn at the next beat/);
});
