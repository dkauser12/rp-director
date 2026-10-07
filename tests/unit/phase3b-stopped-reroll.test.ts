/**
 * Repro: SillyTavern keeps message.extra across a new swipe (clearMessageData
 * does not delete extra.rpd) and copies it into the new swipe's swipe_info
 * while streaming. A swipe generation that is stopped never gets its own
 * marker, so it inherits the PREVIOUS swipe's marker and badge. attemptAt
 * trusts the displayed marker first, so after an explicit Roll again whose
 * generation was stopped, the next swipe silently goes back to the old draw,
 * and the stopped swipe's badge shows the old ruling although it was written
 * under the new one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
const ROOT = new URL('../../', import.meta.url).href;
const { actorIdFor } = await import(ROOT + 'src/identity.ts');
const { choice, harness, noul, scriptJudge } = await import(ROOT + 'tests/unit/support/test-host.ts');

const GUIDE = actorIdFor('Guide', 'guide.png');
const turn = {
  move: choice('s1'), move_count: choice('one'), owner: choice('player'), target: choice(GUIDE),
  family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'), ruling: noul(0.45),
};

test('S1: after Roll again + Stop, the next swipe keeps the new roll', async () => {
  const { host, controller } = await harness();
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false } as any;
  controller.settings.reactions.enabled = false;
  controller.profile.resolutionMethod = 'sample';
  host.context.generate = async (_type: string, options?: Record<string, unknown>) => {
    host.generated.push(options ?? {});
    if (host.composerValue) { host.chat().push({ name: 'Player', is_user: true, is_system: false, mes: host.composerValue }); host.composerValue = ''; }
    await controller.interceptor([], 4096, () => assert.fail('unexpected abort'), 'normal');
    host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: 'Original reply.', swipe_id: 0, swipes: ['Original reply.'], swipe_info: [{ extra: {} }], extra: {} });
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal');
  };
  scriptJudge(controller, turn);
  host.composerValue = 'Open the gate for me.'; await controller.directorSend();
  const message = host.chat().at(-1);
  const original = controller.record.attempts[message.extra.rpd.a];
  const r1 = original.resolutionId;

  // Roll again: the new swipe is generated, then the user presses Stop mid-stream.
  host.swipeRight = async () => {
    message.swipe_id = message.swipes.length;              // ST: new swipe, extra (with rpd) kept
    await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
    await controller.interceptor([], 4096, () => assert.fail('abort'), 'swipe');
    // saveReply('swipe') while streaming: swipe_info copies the CURRENT extra.
    message.mes = 'Partial rewri'; message.swipes.push(message.mes); message.swipe_info.push({ extra: structuredClone(message.extra) });
    await host.emit('GENERATION_STOPPED');
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'swipe');
    await host.emit('CHARACTER_MESSAGE_RENDERED', host.chat().length - 1, 'swipe');
  };
  assert.ok(await controller.reroll(true));
  const rolled = Object.values(controller.record.attempts).at(-1) as any;
  const r2 = rolled.resolutionId;
  assert.notEqual(r2, r1, 'Roll again drew a new ruling for the stopped swipe');
  const badge = host.readWorkflowBadge(host.chat().length - 1);
  console.log('stopped swipe written under', r2, '| its marker points at', message.extra.rpd.a === original.attemptId ? 'the ORIGINAL attempt' : 'its own attempt',
    '| badge attempt', badge?.attemptId === original.attemptId ? 'ORIGINAL' : badge?.attemptId);

  // The next wording swipe.
  const requests = scriptJudge(controller, turn);
  host.swipeRight = async () => {};
  message.swipe_id = message.swipes.length;
  await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
  await controller.interceptor([], 4096, () => assert.fail('abort'), 'swipe');
  const next = Object.values(controller.record.attempts).at(-1) as any;
  console.log('next swipe uses', next.resolutionId === r1 ? 'the OLD roll r1' : next.resolutionId === r2 ? 'the new roll r2' : next.resolutionId, '| judge requests:', requests.length);
  assert.equal(next.resolutionId, r2, 'BUG: the explicit Roll again was silently reverted to the old draw');
});
