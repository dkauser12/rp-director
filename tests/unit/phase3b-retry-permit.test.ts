/**
 * Repro: "Try the judge again" (replay retry) copies the source's NPC permit id
 * onto the new attempt but never injects that permit; instead it offers the
 * NPC tool again. The writer is therefore free to propose the same NPC action
 * and get a NEW permit with new dice, and when it does not, the attempt carries
 * NPC results the reply never saw (later wording swipes do inject them).
 * Item 5: "A retry keeps every stage that succeeded, including ... its draw."
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
const ROOT = new URL('../../', import.meta.url).href;
const { actorIdFor } = await import(ROOT + 'src/identity.ts');
const { TestHost, choice, scriptJudge } = await import(ROOT + 'tests/unit/support/test-host.ts');
const { Controller } = await import(ROOT + 'src/controller.ts');

const GUIDE = actorIdFor('Guide', 'guide.png');

test('P1: a judge retry keeps the NPC permit that succeeded', async () => {
  const host = new TestHost();
  // A writer backend with function tools.
  Object.assign(host.context, { registerFunctionTool: () => {}, unregisterFunctionTool: () => {}, isToolCallingSupported: () => true, canPerformToolCalls: () => true });
  const controller = new Controller(host);
  await controller.init();
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false } as any;
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('default');
  host.context.generate = async () => {
    if (host.composerValue) { host.chat().push({ name: 'Player', is_user: true, is_system: false, mes: host.composerValue }); host.composerValue = ''; }
    await controller.interceptor([], 4096, () => assert.fail('abort'), 'normal');
    host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: 'The guard lunges.', swipe_id: 0, swipes: ['The guard lunges.'], swipe_info: [{ extra: {} }], extra: {} });
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal');
  };
  // The ruling stage fails (no ruling answer): the reply is unruled and retry-eligible.
  scriptJudge(controller, { move: choice('s1'), move_count: choice('one'), owner: choice('player'), target: choice(GUIDE), family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE') });
  host.composerValue = 'Open the gate for me.'; await controller.directorSend();
  const source = Object.values(controller.record.attempts).at(-1) as any;
  assert.deepEqual(source.judgeFailedStages, ['ruling']);
  // The writer had called the NPC tool and kept a permit (stand-in for a real tool result).
  const permit = { schemaVersion: 1, permitId: 'perm_kept', attemptId: source.attemptId, speakerActorId: GUIDE, baseCursor: source.cursorBefore, stateRevision: 0,
    actions: [{ actingActorId: GUIDE, outcome: 'achieved', draw: 0.12, instruction: 'The guard lands the blow.' }], compactState: { sceneId: 0, revision: 0 }, constraints: [], createdAt: Date.now() };
  controller.record.permits.perm_kept = permit;
  source.permitId = 'perm_kept';
  controller.record.variants[source.variantId].permitId = 'perm_kept';

  // Try the judge again (the ruling now succeeds).
  scriptJudge(controller, { move: choice('s1'), move_count: choice('one'), owner: choice('player'), target: choice(GUIDE), family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'), ruling: { type: 'noul', noul: 0.4, confidence: null, provenance: 'fixture' } });
  const message = host.chat().at(-1);
  let injected = '';
  host.swipeRight = async () => {
    message.swipe_id = message.swipes.length;
    await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
    await controller.interceptor([], 4096, () => assert.fail('abort'), 'swipe');
    injected = host.injection;
  };
  assert.ok(await controller.retryJudge());
  const retried = Object.values(controller.record.attempts).at(-1) as any;
  console.log('retried attempt permitId:', retried.permitId, '| permit injected:', /\[Director turn permit/.test(injected), '| NPC tool offered again:', /\[Director NPC-action checkpoint\]/.test(injected));
  assert.equal(retried.permitId, 'perm_kept');
  assert.ok(/\[Director turn permit/.test(injected), 'BUG: the kept NPC permit is attached but not given to the writer; the tool is offered again instead');
});
