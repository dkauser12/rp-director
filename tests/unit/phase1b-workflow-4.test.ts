import assert from 'node:assert/strict';
import { test } from 'node:test';
const ROOT = new URL('../../', import.meta.url).href;
const { actorIdFor } = await import(ROOT + 'src/identity.ts');
const { noul, harness, scriptJudge } = await import(ROOT + 'tests/unit/support/test-host.ts');
const GUIDE = actorIdFor('Guide', 'guide.png');

test('R10: a pre-Director swipe leaves the manual draft for the next Send', async () => {
  const { host, controller } = await harness() as any;
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false };
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('default');
  controller.setActionDraft({ templateId: 'influence_negotiate', actingActorId: 'player', targetActorIds: [GUIDE],
    attemptedAction: 'Bribe the guard with gold (for my NEXT message)', requestedGain: 'the guard lets me pass', applicability: 'favorable',
    uncertainConsequential: true, opposed: false, failureStakeKind: 'delay', failureStakeDetail: 'x', availableEvidence: '' });
  const requests = scriptJudge(controller, { ruling: noul(0.7) });
  const msg = host.chat().at(-1)!;
  msg.swipe_id = msg.swipes!.length;
  await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
  await controller.interceptor([], 4096, () => {}, 'swipe');
  const res = Object.values(controller.record.resolutions)[0] as any;
  assert.ok(controller.actionDraft); assert.ok(!res || !res.action.attemptedAction.includes("NEXT message"));
});
