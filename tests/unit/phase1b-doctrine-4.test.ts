import { test } from 'node:test';
import assert from 'node:assert/strict';
const ROOT = new URL('../../', import.meta.url).href;
const { actorIdFor } = await import(ROOT + 'src/identity.ts');
const { harness, noul, scriptJudge, writerReplies } = await import(ROOT + 'tests/unit/support/test-host.ts');
const GUIDE = actorIdFor('Guide', 'guide.png');

for (const pack of ['default', 'romance', 'investigation', 'politics']) test(`T13 manual attempt in the ${pack} pack`, async () => {
  const { host, controller } = await harness() as any;
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false } as any;
  controller.settings.reactions.enabled = false;
  await controller.setChatPack(pack);
  controller.setActionDraft({ templateId: controller.chatPack().families[0].key, actingActorId: 'player', targetActorIds: [GUIDE],
    attemptedAction: 'Offer a silver coin', requestedGain: 'the guide opens the gate', applicability: 'favorable',
    uncertainConsequential: true, opposed: false, failureStakeKind: 'delay', failureStakeDetail: 'the gate stays closed', availableEvidence: 'He keeps glancing at my purse' });
  const requests = scriptJudge(controller, { ruling: noul(0.7) });
  host.composerValue = 'Open the gate for me.';
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide speaks.');
  await controller.directorSend();
  const ruling = requests.find((r: any) => 'ruling' in r.questions);
  assert.equal(Object.keys(controller.record.resolutions).length, 1); assert.ok(ruling); assert.match(JSON.stringify(ruling), /glancing at my purse/); assert.equal(controller.actionDraft, null);
});
