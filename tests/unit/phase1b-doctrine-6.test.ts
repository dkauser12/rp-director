import { test } from 'node:test';
import assert from 'node:assert/strict';
const ROOT = new URL('../../', import.meta.url).href;
const { actorIdFor } = await import(ROOT + 'src/identity.ts');
const { choice, harness, noul, scriptJudge } = await import(ROOT + 'tests/unit/support/test-host.ts');
const GUIDE = actorIdFor('Guide', 'guide.png');
const turn = { move: choice('s1'), move_count: choice('one'), owner: choice('player'), target: choice(GUIDE), family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'), ruling: noul(0.45) };

test('T15: a failed writer retains its ruling for the next native generation', async () => {
  const { host, controller } = await harness() as any;
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false } as any;
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('default');
  scriptJudge(controller, turn);
  host.context.generate = async () => {
    host.chat().push({ name: 'Player', is_user: true, is_system: false, mes: host.composerValue }); host.composerValue = '';
    await controller.interceptor([], 4096, () => assert.fail('abort'), 'normal');
    throw new Error('API error 502');
  };
  host.composerValue = 'Open the gate for me.';
  await controller.directorSend();
  const bound = Object.values(controller.record.resolutions)[0] as any;
  assert.ok(bound?.cursorBefore);
  // User presses Send with an empty composer (not intercepted) -> native normal generation.
  const requests = scriptJudge(controller, turn);
  await controller.interceptor([], 4096, () => {}, 'normal');
  assert.match(host.injection, /Director ruling/); assert.equal(requests.length, 0);
});
