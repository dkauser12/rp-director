/**
 * C3 meter reader. macroState() indexes meters by actor id AND display name
 * (controller.ts macroState: `if (name) meters[name] = words`). Two group members
 * with the same display name overwrite each other, so the name lookup silently
 * returns whichever was written last. macros.ts own() documents that ambiguous
 * names "have no safe value"; exact duplicates should be treated the same way.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './support/test-host.ts';

for (const otherName of ['Guard', 'gUArd']) test(`C3: duplicate display name Guard/${otherName} leaves meter ids readable and names empty`, async t => {
  const { controller } = await harness({ group: true });
  t.after(() => controller.destroy());
  controller.settings.modules.meters = true;
  await controller.setChatPack('romance');
  const record = controller.record!; // persist() compacts into a new object, so take it after
  const pack = controller.chatPack();
  const meter = pack.meters[0]!;
  record.actors['guard-a'] = { actorId: 'guard-a', avatar: 'guard-a.png', name: 'Guard', control: 'npc' } as any;
  record.actors['guard-b'] = { actorId: 'guard-b', avatar: 'guard-b.png', name: otherName, control: 'npc' } as any;
  record.attempts['att-dup'] = { attemptId: 'att-dup', status: 'writing', resolutionId: null, cursorBefore: 'c', epoch: controller.epoch, createdAt: Date.now(),
    frozenPackId: pack.id, injectedText: '[Director character state — judged from play]',
    storyAfter: { at: 0, meters: { 'guard-a': { [meter.key]: 0 }, 'guard-b': { [meter.key]: meter.levels.length - 1 } }, knownBy: {} } } as any;
  (controller as any).currentAttemptId = 'att-dup';
  assert.equal(controller.getMacro(`meter::guard-a::${meter.key}`), meter.levels[0], 'sanity: id lookup works');
  assert.equal(controller.getMacro(`meter::guard-b::${meter.key}`), meter.levels.at(-1), 'sanity: id lookup works');
  assert.equal(controller.getMacro(`meter::Guard::${meter.key}`), '', 'a duplicated display name has no safe value');
  assert.equal(controller.getMacro(`meter::guard::${meter.key}`), '', 'case-insensitive lookup is equally ambiguous');
  record.actors['guard-b']!.name = 'guard-a';
  assert.equal(controller.getMacro(`meter::guard-a::${meter.key}`), meter.levels[0], 'an alias never overwrites a stable actor id');
});
