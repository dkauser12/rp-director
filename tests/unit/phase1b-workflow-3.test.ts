import { test } from 'node:test';
import assert from 'node:assert/strict';
const ROOT = new URL('../../', import.meta.url).href;
const { actorIdFor } = await import(ROOT + 'src/identity.ts');
const { Controller } = await import(ROOT + 'src/controller.ts');
const { TestHost, choice, noul, scriptJudge } = await import(ROOT + 'tests/unit/support/test-host.ts');
const GUIDE = actorIdFor('Guide', 'guide.png');
const turn = { move: choice('s1'), move_count: choice('one'), owner: choice('player'), target: choice(GUIDE),
  family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'), ruling: noul(0.45) };

test('R9: swipe-bound tools and their recursive writer request preserve one attempt', async () => {
  const host: any = new TestHost();
  host.context.registerFunctionTool = () => {};
  host.context.unregisterFunctionTool = () => {};
  host.context.isToolCallingSupported = () => true;
  host.context.canPerformToolCalls = () => true;
  const controller: any = new Controller(host);
  await controller.init();
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false };
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('default');
  scriptJudge(controller, turn);
  const msg = host.chat().at(-1)!;
  msg.swipe_id = msg.swipes!.length;
  await host.emit('MESSAGE_SWIPED', host.chat().length - 1); // pre-Director reply -> judged, nativeSwipePending
  await controller.interceptor([], 4096, () => assert.fail('abort'), 'swipe');
  const ids = /requestId ([\w-]+), attemptId ([\w-]+), and speakerActorId ([\w-]+)\./.exec(host.injection);
  assert.ok(ids, 'tool identity injected');
  const attemptId = ids![2]!;
  assert.equal(controller.toolWindow.baseCursor, controller.cursorOf(host.chat().slice(0, controller.toolWindow.chatLengthAtBind))); assert.equal(controller.record.attempts[attemptId].status, "writing");
  const result = JSON.parse(await controller.onToolCall({ schemaVersion: 1, requestId: ids![1], attemptId, speakerActorId: ids![3], actions: [{
    proposalId: 'p1', actingActorId: ids![3], targetActorIds: [], family: 'overcome_operate', method: 'works the lock with a pick',
    boundedResult: 'the gate lock opens', failureStake: { kind: 'delay', detail: 'the gate stays shut' }, opposed: false, evidenceRefs: ['latest_input'] }] }));
  assert.equal(result.ok, true); assert.ok(controller.record.attempts[attemptId].permitId);
  // Native tool recursion saves a system invocation before appending the final reply.
  host.chat().push({ name: 'System', is_user: false, is_system: true, mes: 'Tool result', extra: { tool_invocations: [{ result }] } });
  // ST's tool recursion: Generate('normal', { depth: 1 }) emits GENERATION_STARTED('normal') before interceptors.
  await host.emit('GENERATION_STARTED', 'normal', {});
  assert.equal(controller.record.attempts[attemptId].status, "writing");
  const hadRuling = /Director ruling/.test(host.injection); await controller.interceptor([], 4096, () => assert.fail('followup abort'), 'normal'); assert.equal(hadRuling, true); assert.match(host.injection, /Director ruling/);
  const prose = 'The guide works the lock.';
  host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: prose, swipe_id: 0, swipes: [prose], extra: {}, swipe_info: [{ extra: {} }] });
  await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal');
  await new Promise(r => setTimeout(r, 10));
  assert.ok(host.readMarker(host.chat().length - 1)); assert.ok(host.readWorkflowBadge(host.chat().length - 1));
});
