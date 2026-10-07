/**
 * C5. The HAND_BACK decision is frozen per turn (correct), but the frozen text also
 * freezes whether Dynamic Response (DR) was on. If DR is turned off afterwards,
 * nothing will scrub <dynamic_response> tags, yet every later wording swipe of that
 * turn still asks the writer for one, so the raw tag lands in the visible reply and
 * in later prompts. Correct behaviour: keep the frozen HAND_BACK and its stop order,
 * but emit the tag line only while DR is actually available.
 * (tests/unit/phase3-pacing.test.ts:150-156 currently asserts the opposite.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, scriptJudge, writerReplies, choice } from './support/test-host.ts';

test('C5: a wording swipe after Dynamic Response is switched off keeps the stop order but drops the tag line', async t => {
  const { host, controller } = await harness();
  t.after(() => controller.destroy());
  controller.settings.modules = { speaker: false, decisions: false, meters: false, secrets: false, lore: false, pacing: true, replyCheck: false };
  controller.settings.reactions.enabled = false;
  host.context.extensionSettings.dynamic_response = { enabled: true };
  await controller.setChatPack('default');
  scriptJudge(controller, { scene: choice('conversation'), hand_back: choice('HAND_BACK') });
  const writer = writerReplies(host, controller, 'Guide', 'guide.png', 'Which path will you take?');
  host.composerValue = 'Show me the paths.';
  await controller.directorSend();
  assert.match(writer.injected(), /<dynamic_response>/, 'sanity: DR on at the Send');
  host.context.extensionSettings.dynamic_response = { enabled: false };
  await controller.interceptor([], 4096, () => assert.fail('unexpected abort'), 'swipe');
  assert.match(host.injection, /End this reply at the first beat/, 'the frozen hand-back decision is kept');
  assert.doesNotMatch(host.injection, /<dynamic_response>/, 'no tag is requested once nothing will scrub it');
});

test('C5: old frozen tag suffixes follow live availability without changing the frozen decision', async () => {
  const { freezePacing, pacingBlock } = await import('../../src/pacing.ts');
  const { DEFAULT_PACING_TEXTS } = await import('../../src/ui-preferences.ts');
  const frozen = freezePacing({ scene: choice('conversation'), hand_back: choice('HAND_BACK') }, { texts: DEFAULT_PACING_TEXTS, handBack: true, dynamicResponse: true, playerName: 'Player' })!;
  frozen.handBackInstruction += '\nPut <dynamic_response>a brief in-fiction cue</dynamic_response> on its own line at the very end of the reply. Replace the tag contents with a brief cue from the scene.';
  const saved = structuredClone(frozen);
  assert.doesNotMatch(pacingBlock(frozen, true, false), /dynamic_response/);
  assert.equal((pacingBlock(frozen, true, true).match(/<dynamic_response>/g) ?? []).length, 1);
  assert.deepEqual(frozen, saved);
});
