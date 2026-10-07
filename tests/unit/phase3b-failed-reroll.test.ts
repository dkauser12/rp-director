/** Repro: after an explicit Roll again whose writer FAILED (ST reverts the swipe), the next swipe silently uses the old draw. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
const ROOT = new URL('../../', import.meta.url).href;
const { actorIdFor } = await import(ROOT + 'src/identity.ts');
const { choice, harness, noul, scriptJudge } = await import(ROOT + 'tests/unit/support/test-host.ts');
const GUIDE = actorIdFor('Guide', 'guide.png');
const turn = { move: choice('s1'), move_count: choice('one'), owner: choice('player'), target: choice(GUIDE), family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'), ruling: noul(0.45) };

test('S2: after Roll again + writer failure, the next swipe keeps the new roll', async () => {
  const { host, controller } = await harness();
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false } as any;
  controller.settings.reactions.enabled = false;
  controller.profile.resolutionMethod = 'sample';
  host.context.generate = async () => {
    if (host.composerValue) { host.chat().push({ name: 'Player', is_user: true, is_system: false, mes: host.composerValue }); host.composerValue = ''; }
    await controller.interceptor([], 4096, () => assert.fail('abort'), 'normal');
    host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: 'Original reply.', swipe_id: 0, swipes: ['Original reply.'], swipe_info: [{ extra: {} }], extra: {} });
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal');
  };
  scriptJudge(controller, turn);
  host.composerValue = 'Open the gate for me.'; await controller.directorSend();
  const message = host.chat().at(-1);
  const r1 = controller.record.attempts[message.extra.rpd.a].resolutionId;
  host.swipeRight = async () => {
    message.swipe_id = message.swipes.length;
    await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
    await controller.interceptor([], 4096, () => assert.fail('abort'), 'swipe');
    await host.emit('GENERATION_ENDED');           // the writer request failed, no reply
    await new Promise(r => setTimeout(r, 5));
    message.swipe_id = 0;                          // ST endSwipe(): swipe back to the last valid swipe
  };
  assert.ok(await controller.reroll(true));
  const r2 = (Object.values(controller.record.attempts).at(-1) as any).resolutionId;
  assert.notEqual(r2, r1);
  host.swipeRight = async () => {};
  message.swipe_id = message.swipes.length;
  await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
  await controller.interceptor([], 4096, () => assert.fail('abort'), 'swipe');
  const next = (Object.values(controller.record.attempts).at(-1) as any).resolutionId;
  console.log('next swipe uses:', next === r1 ? 'OLD roll r1' : next === r2 ? 'new roll r2' : next);
  assert.equal(next, r2, 'BUG: the explicit Roll again was discarded after the failed writer');
});
