import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../../src/controller.ts';
import { actorIdFor } from '../../src/identity.ts';
import { TestHost, choice, noul, scriptJudge, writerReplies } from './support/test-host.ts';

const GUIDE = actorIdFor('Guide', 'guide.png');
async function ruledGroup(setters = true) {
  const host = new TestHost({ group: true });
  for (const name of ['GROUP_WRAPPER_STARTED', 'GROUP_MEMBER_DRAFTED', 'GROUP_WRAPPER_FINISHED']) host.context.eventTypes[name] = name;
  if (setters) Object.assign(host, { flags: {
    setCharacterId(index: number) { host.context.characterId = index; }, setCharacterName() {},
  } });
  const controller = new Controller(host); await controller.init();
  controller.settings.modules = { speaker: true, decisions: true, meters: false, secrets: false, lore: false, pacing: false, replyCheck: false };
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('default');
  const requests = scriptJudge(controller, { speaker: choice(GUIDE), move: choice('s1'), move_count: choice('one'), owner: choice('player'),
    target: choice(GUIDE), family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'), ruling: noul(0.45) });
  host.composerValue = 'Please open the gate.';
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide answers.');
  await controller.directorSend();
  return { host, controller, requests };
}

test('3b item 12: native group regenerate overrides a newly drafted member before prompt construction', async () => {
  const { host, controller, requests } = await ruledGroup();
  const frozen = Object.values(controller.record!.attempts).at(-1)!;
  const count = requests.length;
  const injection = frozen.injectedText;
  host.chat().pop(); // native regenerate deletes the previous reply first
  await host.emit('MESSAGE_DELETED'); await new Promise(resolve => setImmediate(resolve));
  await host.emit('GROUP_WRAPPER_STARTED', { type: 'normal' });
  host.context.characterId = 1; // native natural-order selection differs
  await host.emit('GROUP_MEMBER_DRAFTED', 1);
  assert.equal(host.context.characterId, 0, 'the frozen speaker is restored before Generate reads the character card');
  await host.emit('GENERATION_STARTED', 'normal');
  await controller.interceptor([], 4096, () => assert.fail('frozen speaker is available'), 'normal');
  const reused = Object.values(controller.record!.attempts).at(-1)!;
  assert.equal(reused.actorId, GUIDE);
  assert.equal(reused.resolutionId, frozen.resolutionId);
  assert.equal(requests.length, count);
  assert.match(host.injection, /Director ruling/);
  assert.ok(injection.includes('[Director ruling'));
});

test('3b item 12: unavailable host speaker setter cannot apply a frozen ruling to another member', async () => {
  const { host, controller } = await ruledGroup(false);
  const resolutions = structuredClone(controller.record!.resolutions);
  host.chat().pop();
  await host.emit('GROUP_WRAPPER_STARTED', { type: 'normal' });
  host.context.characterId = 1;
  await host.emit('GROUP_MEMBER_DRAFTED', 1);
  let aborted = false;
  await controller.interceptor([], 4096, () => { aborted = true; }, 'normal');
  assert.equal(aborted, true);
  assert.equal(host.injection, '');
  assert.deepEqual(controller.record!.resolutions, resolutions);
  assert.ok(host.notices.some(text => text.includes('frozen reply speaker')));
});
