import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, choice, scriptJudge, writerReplies } from './support/test-host.ts';

test('frozen meter and knowledge instructions keep their original labels and obey module switches', async () => {
  const { host, controller } = await harness();
  controller.settings.modules = { speaker: false, decisions: false, meters: true, secrets: true, lore: false };
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('romance');
  await controller.addSecret('The key is under the bench.', [controller.actorsForUi()[0]!.actorId]);
  scriptJudge(controller, { meter_1_regard: choice('warm'), meter_1_nerve: choice('steady') });
  host.composerValue = 'Hello.';
  writerReplies(host, controller, 'Guide', 'guide.png', 'Welcome.');
  await controller.directorSend();
  const source = Object.values(controller.record!.attempts).at(-1)!;
  const original = source.frozenStateBlock!;
  assert.match(original, /\[Director character state — judged from play\]/);
  assert.match(original, /\[Director knowledge boundaries\]/);
  await controller.setChatPack('investigation');
  await controller.interceptor([], 4096, () => assert.fail('unexpected abort'), 'swipe');
  assert.equal(host.injection, original);
  await host.emit('GENERATION_ENDED');
  controller.settings.modules.meters = false;
  await controller.interceptor([], 4096, () => assert.fail('unexpected abort'), 'swipe');
  assert.doesNotMatch(host.injection, /Director character state/);
  assert.match(host.injection, /Director knowledge boundaries/);
  await host.emit('GENERATION_ENDED');
  controller.settings.modules.secrets = false;
  await controller.interceptor([], 4096, () => assert.fail('unexpected abort'), 'swipe');
  assert.equal(host.injection, '');
});

test('25: a legacy attempt rebuilds its writer block without obsolete scene or permit instructions', async () => {
  const { host, controller } = await harness();
  controller.settings.modules = { speaker: false, decisions: false, meters: true, secrets: false, lore: false };
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('romance');
  scriptJudge(controller, { meter_1_regard: choice('warm'), meter_1_nerve: choice('steady') });
  host.composerValue = 'Hello.';
  writerReplies(host, controller, 'Guide', 'guide.png', 'Welcome.');
  await controller.directorSend();
  const source = Object.values(controller.record!.attempts).at(-1)!;
  delete source.frozenStateBlock;
  delete source.storyAfter;
  source.injectedText = '[Scene transition requested]\nOBSOLETE PERMIT AND DUPLICATE REACTION';
  host.chat().at(-1)!.mes = 'Welcome, with a typo corrected.';
  await host.emit('MESSAGE_EDITED', host.chat().length - 1);
  await controller.interceptor([], 4096, () => assert.fail('unexpected abort'), 'swipe');
  assert.doesNotMatch(host.injection, /Scene transition|OBSOLETE/);
  assert.match(host.injection, /\[Director character state — judged from play\]/);
  assert.match(host.injection, /warm/);
});

test('the NPC reaction writer header remains exact', async () => {
  const { host, controller } = await harness();
  controller.settings.modules = { speaker: false, decisions: false, meters: false, secrets: false, lore: false };
  controller.settings.reactions.enabled = true;
  await controller.setChatPack('default');
  scriptJudge(controller, { move: choice('NONE'), move_count: choice('one'), npc_reaction_1: choice('resolve') });
  host.composerValue = 'Hello.';
  const writer = writerReplies(host, controller, 'Guide', 'guide.png', 'Welcome.');
  await controller.directorSend();
  assert.match(writer.injected(), /\[Director NPC reaction — preserve on wording swipes\]/);
});
