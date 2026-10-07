/**
 * C5. Dynamic Response (DR) scrubs <dynamic_response> tags only when its module
 * is loaded. SillyTavern's Manage Extensions "disable" just adds
 * 'third-party/DynamicResponse' to extension_settings.disabledExtensions
 * (public/scripts/extensions.js:490-492, checked at load :626) and never touches
 * extension_settings.dynamic_response, which keeps enabled:true. The brief says
 * the tag is requested only "when Dynamic Response is installed and enabled".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, scriptJudge, writerReplies, choice } from './support/test-host.ts';

async function handBackTurn(extensionSettings: Record<string, unknown>, installed = true) {
  const { host, controller } = await harness();
  controller.settings.modules = { speaker: false, decisions: false, meters: false, secrets: false, lore: false, pacing: true, replyCheck: false };
  controller.settings.reactions.enabled = false;
  Object.assign(host.context.extensionSettings, extensionSettings);
  if (!installed) host.installedExtensions = [];
  await controller.setChatPack('default');
  scriptJudge(controller, { scene: choice('conversation'), hand_back: choice('HAND_BACK') });
  const writer = writerReplies(host, controller, 'Guide', 'guide.png', 'Which path will you take?');
  host.composerValue = 'Show me the paths.';
  await controller.directorSend();
  controller.destroy();
  return writer.injected();
}

test('C5 sanity: DR loaded and enabled gets the cue-tag instruction', async () => {
  const injected = await handBackTurn({ dynamic_response: { enabled: true }, disabledExtensions: [] });
  assert.match(injected, /Director hand-back/);
  assert.match(injected, /<dynamic_response>/);
});

test('C5: DR disabled in Manage Extensions (own setting still enabled:true) gets no cue-tag instruction', async () => {
  const injected = await handBackTurn({ dynamic_response: { enabled: true, confirmDismiss: true, defaultLabel: 'Your turn.' }, disabledExtensions: ['third-party/DynamicResponse'] });
  assert.match(injected, /End this reply at the first beat/, 'the stop-at-the-beat order is still given');
  assert.doesNotMatch(injected, /<dynamic_response>/, 'nothing will scrub the tag, so it must not be requested');
});

for (const [label, settings, installed] of [
  ['uninstalled with stale settings', { dynamic_response: { enabled: true } }, false],
  ['own switch disabled', { dynamic_response: { enabled: false } }, true],
  ['own setting absent', {}, true],
] as const) test(`C5: ${label} gets no cue-tag instruction`, async () => {
  const injected = await handBackTurn(settings, installed);
  assert.match(injected, /End this reply at the first beat/);
  assert.doesNotMatch(injected, /<dynamic_response>/);
});
