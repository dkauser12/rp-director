import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choice, harness, scriptJudge, writerReplies } from './support/test-host.ts';

test('3b/27: repeated lore reuse compares gradual drift to the original selection scene', async () => {
  const { controller, host } = await harness();
  controller.settings.modules = { speaker: false, decisions: false, meters: false, secrets: false, lore: true };
  controller.settings.reactions.enabled = false;
  controller.settings.lore.books.Atlas = { mode: 'assist', public: true };
  host.loreCatalog = async () => ({ books: [{ world: 'Atlas', source: 'global', owner: null }], entries: [{ world: 'Atlas', uid: 0, title: 'Harbour', keys: ['harbour'], content: 'Ships arrive at the harbour.', constant: false, disabled: false }] });
  host.sortedEntries = async () => [{ world: 'Atlas', uid: 0, content: 'Ships arrive at the harbour.', decorators: [], hash: 10 }];
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide follows.');
  scriptJudge(controller, { lore_public_1_1: choice('n1') });
  host.composerValue = 'We stand on the harbour quay.';
  await controller.directorSend();
  const original = structuredClone(Object.values(controller.record!.story.lore).at(-1)!.scene);
  assert.ok(original);
  for (const text of ['We walk toward the harbour gates.', 'We leave the gates and follow the road.', 'The road leads away from the coast.']) {
    const requests = scriptJudge(controller, { lore_scene: choice('SAME') });
    host.composerValue = text;
    await controller.directorSend();
    assert.deepEqual((requests[0]!.snapshot.state as { previousScene: unknown }).previousScene, original);
    assert.deepEqual(Object.values(controller.record!.story.lore).at(-1)!.scene, original);
  }
  const changed = scriptJudge(controller, { lore_scene: choice('CHANGED'), lore_public_1_1: choice('NONE') });
  host.composerValue = 'We reach the mountain shrine.';
  await controller.directorSend();
  assert.deepEqual((changed[0]!.snapshot.state as { previousScene: unknown }).previousScene, original);
  const latest = Object.values(controller.record!.story.lore).at(-1)!;
  assert.equal((latest.scene as { latestInput: string }).latestInput, 'We reach the mountain shrine.');
  assert.deepEqual(latest.refs, []);
});
