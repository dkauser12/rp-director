import { test } from 'node:test';
import assert from 'node:assert/strict';
const ROOT = new URL('../../', import.meta.url).href;
const { actorIdFor } = await import(ROOT + 'src/identity.ts');
const { choice, harness, noul, scriptJudge, writerReplies } = await import(ROOT + 'tests/unit/support/test-host.ts');
const GUIDE = actorIdFor('Guide', 'guide.png');
const turn = { move: choice('s1'), move_count: choice('one'), owner: choice('player'), target: choice(GUIDE), family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'), ruling: noul(0.45) };

test('T14: a reaction failure cannot offer a retry or reroll a successful ruling', async () => {
  const { host, controller } = await harness() as any;
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false } as any;
  controller.settings.reactions.enabled = true;          // reaction question left unanswered by the script
  controller.settings.profileOverrides.binding = { resolutionMethod: 'sample' };
  controller.reloadProfile();
  await controller.setChatPack('default');
  scriptJudge(controller, turn);
  host.composerValue = 'Open the gate for me.';
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide speaks.');
  await controller.directorSend();
  const badge = host.readWorkflowBadge(host.chat().length - 1);
  assert.equal(badge.retryEligible, false);
  const message = host.chat().at(-1);
  host.swipeRight = async () => {
    message.swipe_id = message.swipes.length;
    await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
    await controller.interceptor([], 4096, () => assert.fail('abort'), 'swipe');
  };
  scriptJudge(controller, turn);
  await controller.retryJudge();
  assert.equal(Object.keys(controller.record.resolutions).length, 1);
});
