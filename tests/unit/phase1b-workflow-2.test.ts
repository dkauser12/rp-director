import { test } from 'node:test';
import assert from 'node:assert/strict';
const ROOT = new URL('../../', import.meta.url).href;
const { actorIdFor } = await import(ROOT + 'src/identity.ts');
const { choice, noul, harness, scriptJudge, writerReplies } = await import(ROOT + 'tests/unit/support/test-host.ts');
const GUIDE = actorIdFor('Guide', 'guide.png');
const turn = { move: choice('s1'), move_count: choice('one'), owner: choice('player'), target: choice(GUIDE),
  family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'), ruling: noul(0.45) };

test('R8: browsing the prior reply while deciding does not drop Send', async () => {
  const { host, controller } = await harness() as any;
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false };
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('default');
  host.composerValue = 'Open the gate for me.';
  const scripted = (() => { scriptJudge(controller, turn); return controller.provider(); })();
  let fired = false;
  controller.provider = () => ({ ...scripted, evaluate: async (request: any, signal: any) => {
    if (!fired) { fired = true; await host.emit('MESSAGE_SWIPED', host.chat().length - 1); } // user flips to another swipe
    return scripted.evaluate(request, signal);
  } });
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide speaks.');
  await controller.directorSend();
  assert.equal(host.generated.length, 1);
});
