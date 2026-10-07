/**
 * Slash commands. When a command cannot act (no chat/record, paused chat, nothing to
 * reroll) it resolves '' with no error and no toast, so the user cannot tell it did
 * nothing. Correct behaviour: either reject (SillyTavern shows the error) or toast.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { HostSlashCommand } from '../../src/host.ts';
import { harness, scriptJudge, choice } from './support/test-host.ts';
import { YIELD } from '../../src/types.ts';

async function setup() {
  const { host, controller } = await harness();
  const commands = new Map<string, HostSlashCommand>();
  host.context.SlashCommand = { fromProps: props => props };
  host.context.SlashCommandParser = { addCommandObject: command => { const item = command as HostSlashCommand; commands.set(item.name, item); } };
  host.registerDirectorCommands({ pause: value => controller.setPaused(value), reroll: () => controller.reroll(true),
    reassess: () => controller.reassess(true), setPack: id => controller.setChatPack(id),
    setSpeaker: name => controller.setSpeakerByName(name), get: key => controller.getMacro(key) });
  const run = async (name: string, arg = '') => {
    const before = host.notices.length;
    try { await commands.get(name)!.callback({}, arg); } catch { return 'rejected'; }
    return host.notices.length > before ? 'toasted' : 'silent';
  };
  const invoke = (name: string, arg = '') => commands.get(name)!.callback({}, arg);
  return { host, controller, run, invoke };
}

test('commands: /director-reroll on a paused chat tells the user it did nothing', async t => {
  const { host, controller, run } = await setup();
  t.after(() => controller.destroy());
  await controller.setPaused(true);
  assert.equal(await run('director-reroll'), 'toasted');
  assert.equal(host.notices.at(-1), 'The Director is paused in this chat.');
  assert.equal(await run('director-reassess'), 'toasted');
  assert.equal(host.notices.at(-1), 'The Director is paused in this chat.');
});

test('commands: /director-pause with no chat open tells the user it did nothing', async t => {
  const { host, controller, run } = await setup();
  t.after(() => controller.destroy());
  controller.record = null; // no chat open (loadChat leaves record null)
  assert.equal(await run('director-pause', 'on'), 'toasted');
  assert.equal(host.notices.at(-1), 'Open a chat first.');
  for (const command of ['director-reroll', 'director-reassess']) {
    assert.equal(await run(command), 'toasted');
    assert.equal(host.notices.at(-1), 'Open a chat first.');
  }
});

test('commands: no selected ruling and disabled modules give actionable warnings', async t => {
  const { host, controller, run } = await setup();
  t.after(() => controller.destroy());
  assert.equal(await run('director-reroll'), 'toasted');
  assert.equal(host.notices.at(-1), 'There is no ruling to roll again.');
  host.context.chat = [];
  assert.equal(await run('director-reassess'), 'toasted');
  assert.match(host.notices.at(-1)!, /no .*reassess/i);
  controller.settings.enabled = false;
  for (const command of ['director-reroll', 'director-reassess']) {
    assert.equal(await run(command), 'toasted');
    assert.match(host.notices.at(-1)!, /Director.*off/i);
  }
  controller.settings.enabled = true;
  controller.settings.modules.decisions = false;
  for (const command of ['director-reroll', 'director-reassess']) {
    assert.equal(await run(command), 'toasted');
    assert.match(host.notices.at(-1)!, /decisions.*off/i);
  }
});

test('commands: speaker accepts yield and the current persona name, rejecting ambiguous or unknown names', async t => {
  const { host, controller, invoke } = await setup();
  t.after(() => controller.destroy());
  await invoke('director-speaker', 'YIELD');
  assert.equal(controller.speakerOverride, YIELD);
  await invoke('director-speaker', 'AUTO');
  assert.equal(controller.speakerOverride, null);
  host.context.name1 = 'Example player';
  await invoke('director-speaker', 'example PLAYER');
  assert.equal(controller.speakerOverride, YIELD);
  await invoke('director-speaker', 'auto');
  await assert.rejects(async () => invoke('director-speaker', 'Missing character'));
  assert.equal(controller.speakerOverride, null);
  host.context.characters[0]!.name = 'Example player';
  await assert.rejects(async () => invoke('director-speaker', 'Example player'));
  assert.equal(controller.speakerOverride, null, 'a persona/NPC name collision must not select either silently');
  await invoke('director-speaker', 'yield');
  assert.equal(controller.speakerOverride, YIELD, 'the explicit keyword remains unambiguous');
});

test('commands: invalid arguments fail without changing pause, pack or speaker', async t => {
  const { controller, invoke } = await setup();
  t.after(() => controller.destroy());
  const before = { paused: controller.record!.paused, pack: controller.chatPack().id, speaker: controller.speakerOverride };
  for (const [command, argument] of [['director-pause', 'maybe'], ['director-pack', 'missing_pack'], ['director-pack', ''], ['director-speaker', '']] as const) {
    await assert.rejects(async () => invoke(command, argument));
  }
  assert.deepEqual({ paused: controller.record!.paused, pack: controller.chatPack().id, speaker: controller.speakerOverride }, before);
});

test('commands: yield posts the user message without an NPC writer in a one-character chat', async t => {
  const { host, controller, invoke } = await setup();
  t.after(() => controller.destroy());
  controller.settings.modules = { speaker: true, decisions: false, meters: false, secrets: false, lore: false, pacing: false, replyCheck: false };
  controller.settings.reactions.enabled = false;
  scriptJudge(controller, { speaker: choice(YIELD) });
  let posted = '';
  host.postUserMessage = async text => { posted = text; return true; };
  await invoke('director-speaker', 'yield');
  host.composerValue = 'I pause to consider the question.';
  await controller.directorSend();
  assert.equal(posted, host.composerValue, 'the player message is posted');
  assert.equal(host.generated.length, 0, 'no NPC generation replaces an explicit yield');
  assert.match(host.notices.at(-1)!, /posted without an NPC reply/);
});
