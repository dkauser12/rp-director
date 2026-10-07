import test from 'node:test';
import assert from 'node:assert/strict';
import { actorIdFor } from '../../src/identity.ts';
import { setResolutionMethod } from '../../src/profiles.ts';
import type { Controller } from '../../src/controller.ts';
import type { HostChatMessage, HostSlashCommand } from '../../src/host.ts';
import { resolveDirectorMacro } from '../../src/macros.ts';
import type { DirectorMacroState } from '../../src/macros.ts';
import { choice, harness, noul, scriptJudge } from './support/test-host.ts';
import type { TestHost } from './support/test-host.ts';

const GUIDE = actorIdFor('Guide', 'guide.png');
const scripted = {
  move: choice('s1'), move_count: choice('one'), owner: choice('player'), target: choice(GUIDE),
  family: choice('ask'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'), ruling: noul(0.45),
  scene: choice('conversation'), hand_back: choice('CONTINUE'), meter_1_regard: choice('warm'), meter_1_nerve: choice('bold'),
};

function writer(host: TestHost, controller: Controller) {
  const captured: DirectorMacroState[] = [];
  const initial: DirectorMacroState[] = [];
  let replies = 0;
  host.context.generate = async () => {
    // This is after Send's pre-pass, before the interceptor binds the user cursor.
    initial.push(structuredClone(controller.macroState()));
    if (host.composerValue) {
      host.chat().push({ name: 'Player', is_user: true, is_system: false, mes: host.composerValue });
      host.composerValue = '';
    }
    await controller.interceptor(structuredClone(host.chat()), 4096, () => assert.fail('unexpected abort'), 'normal');
    captured.push(structuredClone(controller.macroState()));
    const prose = `The guide replies ${++replies}.`;
    host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false,
      mes: prose, swipe_id: 0, swipes: [prose], swipe_info: [{ extra: {} }] });
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal');
  };
  host.swipeRight = async () => {
    const message = host.chat().at(-1)!;
    message.swipe_id = message.swipes!.length;
    await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
    await controller.interceptor(structuredClone(host.chat()), 4096, () => assert.fail('unexpected swipe abort'), 'swipe');
    captured.push(structuredClone(controller.macroState()));
    message.mes = `The guide offers wording ${++replies}.`;
    message.swipes!.push(message.mes);
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'swipe');
  };
  return { captured, initial };
}

async function configured() {
  const h = await harness();
  h.controller.settings.modules = { speaker: false, decisions: true, meters: true, secrets: false, lore: false, pacing: true, replyCheck: false };
  h.controller.settings.reactions.enabled = false;
  setResolutionMethod(h.controller.settings, h.controller.profile.id, 'sample');
  h.controller.reloadProfile();
  await h.controller.setChatPack('romance');
  return h;
}

const read = (state: DirectorMacroState, key: string) => resolveDirectorMacro(state, key);
async function settle() { await new Promise(resolve => setTimeout(resolve, 15)); }

test('C3 real controller exposes this generation after Send, freezes wording swipes and exposes Roll again before writing', async t => {
  const { host, controller } = await configured();
  t.after(() => controller.destroy());
  let draw = 0;
  t.mock.method(globalThis.crypto, 'getRandomValues', <T extends ArrayBufferView | null>(buffer: T): T => {
    (buffer as unknown as Uint32Array)[0] = draw;
    return buffer;
  });
  assert.equal(controller.getMacro('active'), '');
  const captures = writer(host, controller);
  const requests = scriptJudge(controller, scripted);
  host.composerValue = 'Please open the gate for me.';
  await controller.directorSend();
  const first = captures.captured[0]!;
  assert.equal(captures.initial[0]!.active, true, 'Send pre-pass publishes before host generation starts');
  assert.equal(read(first, 'active'), 'true');
  assert.notEqual(read(first, 'outcome'), '');
  assert.match(read(first, 'odds'), /^\d+%$/);
  assert.equal(read(first, 'roll'), '0/100');
  assert.equal(read(first, 'scene'), 'conversation');
  assert.equal(read(first, 'pack'), 'romance');
  assert.equal(read(first, 'meter::Guide::regard'), 'warm');
  assert.equal(controller.getMacro('roll'), '', 'completed reply cannot leak into a future generation');
  const requestCount = requests.length;
  await controller.regenerateSelected(); await settle();
  assert.deepEqual(captures.captured[1], first);
  assert.equal(requests.length, requestCount, 'wording swipe makes no judge calls');
  draw = 3865470566;
  assert.equal(await controller.reroll(true), true); await settle();
  const rolled = captures.captured[2]!;
  assert.equal(read(rolled, 'roll'), '90/100');
  assert.equal(read(rolled, 'scene'), read(first, 'scene'));
  assert.equal(read(rolled, 'meter::Guide::regard'), read(first, 'meter::Guide::regard'));
  assert.equal(requests.length, requestCount, 'Roll again changes only the draw');
});

test('C3 wording readers keep their frozen pack and meter words after a later pack choice', async t => {
  const { host, controller } = await configured();
  t.after(() => controller.destroy());
  const { captured } = writer(host, controller);
  scriptJudge(controller, scripted);
  host.composerValue = 'Please open the gate for me.';
  await controller.directorSend();
  assert.equal(read(captured[0]!, 'meter::Guide::regard'), 'warm');
  await controller.setChatPack('adventure');
  await controller.regenerateSelected(); await settle();
  assert.equal(read(captured[1]!, 'pack'), 'romance');
  assert.equal(read(captured[1]!, 'meter::Guide::regard'), 'warm');
});

test('C3 generation readers honor module-off, paused, disabled and no-ruling turns without stale values', async t => {
  const { host, controller } = await configured();
  t.after(() => controller.destroy());
  const { captured } = writer(host, controller);
  scriptJudge(controller, scripted);
  host.composerValue = 'Please open the gate for me.';
  await controller.directorSend();
  controller.settings.modules.decisions = false;
  controller.settings.modules.meters = false;
  controller.settings.modules.pacing = false;
  controller.settings.modules.speaker = true;
  await controller.regenerateSelected(); await settle();
  for (const key of ['outcome', 'odds', 'roll', 'scene', 'meter::Guide::regard', 'module::meters', 'module::pacing']) assert.equal(read(captured[1]!, key), '', key);
  assert.equal(read(captured[1]!, 'module::speaker'), 'true');
  await controller.setPaused(true);
  assert.equal(controller.getMacro('active'), '');
  await controller.setPaused(false);
  controller.setEnabled(false);
  assert.equal(controller.getMacro('active'), '');
  controller.setEnabled(true);
  controller.settings.modules.decisions = true;
  controller.settings.modules.pacing = true;
  scriptJudge(controller, { move: choice('NONE'), move_count: choice('one'), scene: choice('downtime'), hand_back: choice('CONTINUE') });
  host.composerValue = 'I watch the clouds.';
  await controller.directorSend();
  const noMove = captured.at(-1)!;
  for (const key of ['outcome', 'odds', 'roll']) assert.equal(read(noMove, key), '', key);
  assert.equal(read(noMove, 'scene'), '', 'downtime has no pacing instruction in this generation');
  controller.settings.modules = { speaker: false, decisions: false, meters: false, secrets: false, lore: false, pacing: false, replyCheck: false };
  await controller.interceptor(structuredClone(host.chat()) as HostChatMessage[], 4096, () => {}, 'normal');
  assert.equal(controller.getMacro('active'), '');
});

test('C3 real pack command rejects unknown ids without changing the selected pack', async t => {
  const { host, controller } = await configured();
  t.after(() => controller.destroy());
  const commands = new Map<string, HostSlashCommand>();
  host.context.SlashCommand = { fromProps: props => props };
  host.context.SlashCommandParser = { addCommandObject: command => { const item = command as HostSlashCommand; commands.set(item.name, item); } };
  host.registerDirectorCommands({ pause: value => controller.setPaused(value), reroll: () => controller.reroll(true),
    reassess: () => controller.reassess(true), setPack: id => controller.setChatPack(id),
    setSpeaker: name => controller.setSpeakerByName(name), get: key => controller.getMacro(key) });
  const command = commands.get('director-pack')!;
  await assert.rejects(async () => command.callback({}, 'romnace'), /pack/i);
  assert.equal(controller.record!.story.packId, 'romance');
  await command.callback({}, 'adventure');
  assert.equal(controller.record!.story.packId, 'adventure');
  await command.callback({}, 'auto');
  assert.equal(controller.record!.story.packId, 'auto');
});

test('C1 cache placement stays depth zero/system despite legacy profile injection overrides', async t => {
  const { host, controller } = await configured();
  t.after(() => controller.destroy());
  controller.settings.profileOverrides[controller.profile.id] = { injection: { depth: 4, role: 'user' } };
  controller.reloadProfile();
  const placements: { text: string; position: number; depth: number; role: number | undefined }[] = [];
  const original = host.context.setExtensionPrompt;
  host.context.setExtensionPrompt = (key, text, position, depth, scan, role, filter) => {
    if (text) placements.push({ text, position, depth, role });
    original(key, text, position, depth, scan, role, filter);
  };
  writer(host, controller);
  scriptJudge(controller, scripted);
  host.composerValue = 'Please open the gate for me.';
  await controller.directorSend();
  assert.ok(placements.length);
  assert.ok(placements.some(item => item.text.includes('[Director pacing')));
  assert.ok(placements.every(item => item.position === 1 && item.depth === 0 && item.role === 0), 'all Director additions stay in-chat at depth zero as system text');
});

test('C3 a pack choice during judging applies to future turns, while current macros keep the judged pack', async t => {
  const { host, controller } = await configured();
  t.after(() => controller.destroy());
  controller.settings.modules.decisions = false;
  controller.settings.modules.pacing = false;
  scriptJudge(controller, scripted);
  const original = controller.provider();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  controller.provider = () => ({ ...original, evaluate: async (request, signal) => {
    entered = true;
    await gate;
    return original.evaluate(request, signal);
  } });
  const { captured } = writer(host, controller);
  host.composerValue = 'Hello.';
  const sending = controller.directorSend();
  for (let n = 0; n < 100 && !entered; n++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(entered, true);
  await controller.setChatPack('adventure');
  release();
  await sending;
  assert.equal(controller.record!.story.packId, 'adventure', 'new preference is preserved for the next turn');
  assert.equal(read(captured[0]!, 'pack'), 'romance');
  assert.equal(read(captured[0]!, 'meter::Guide::regard'), 'warm');
});
