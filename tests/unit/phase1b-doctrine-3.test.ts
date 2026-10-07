import { test } from 'node:test';
import assert from 'node:assert/strict';
const ROOT = new URL('../../', import.meta.url).href;
const { actorIdFor } = await import(ROOT + 'src/identity.ts');
const { choice, harness, noul, scriptJudge } = await import(ROOT + 'tests/unit/support/test-host.ts');
const GUIDE = actorIdFor('Guide', 'guide.png');
const turn = { move: choice('s1'), move_count: choice('one'), owner: choice('player'), target: choice(GUIDE), family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'), ruling: noul(0.45) };

test('T11: a stopped partial reply keeps its frozen draw when swiped', async () => {
  const { host, controller } = await harness() as any;
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false } as any;
  controller.settings.reactions.enabled = false;
  controller.settings.askWhenSwiping = true;
  controller.settings.profileOverrides.binding = { resolutionMethod: 'sample' };
  controller.reloadProfile();
  await controller.setChatPack('default');
  let prompts = 0;
  host.swipeResult = async () => { prompts++; return 'reuse'; };
  scriptJudge(controller, turn);
  host.context.generate = async () => {
    host.chat().push({ name: 'Player', is_user: true, is_system: false, mes: host.composerValue }); host.composerValue = '';
    await controller.interceptor([], 4096, () => assert.fail('abort'), 'normal');
    await host.emit('GENERATION_STOPPED');            // user presses Stop mid-stream
    host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: 'The guide shakes his head and', swipe_id: 0, swipes: ['The guide shakes his head and'], swipe_info: [{ extra: {} }] });
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal'); // ST still saves the partial reply
  };
  host.composerValue = 'Open the gate for me.';
  await controller.directorSend();
  const first = Object.values(controller.record.resolutions)[0] as any;
  const requests = scriptJudge(controller, turn);
  const message = host.chat().at(-1);
  message.swipe_id = message.swipes.length;
  await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
  await controller.interceptor([], 4096, () => assert.fail('abort'), 'swipe');
  const all = Object.values(controller.record.resolutions) as any[];
  assert.equal(requests.length, 0); assert.equal(Object.keys(controller.record.resolutions).length, 1); assert.equal(prompts, 1);
  void first;
});

test('T12: deleting a turn and resending starts from the surviving meters', async () => {
  const { host, controller } = await harness() as any;
  controller.settings.modules = { speaker: false, decisions: false, meters: true, secrets: false, lore: false } as any;
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('romance');
  const answers = (regard: string) => ({ move: choice('NONE'), move_count: choice('one'), meter_1_regard: choice(regard), meter_1_nerve: choice('steady') });
  let n = 0;
  host.context.generate = async () => {
    if (host.composerValue) { host.chat().push({ name: 'Player', is_user: true, is_system: false, mes: host.composerValue }); host.composerValue = ''; }
    await controller.interceptor([], 4096, () => assert.fail('abort'), 'normal');
    const text = `Reply ${++n}.`;
    host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }] });
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal');
  };
  scriptJudge(controller, answers('friendly'));
  host.composerValue = 'Hello.'; await controller.directorSend();
  scriptJudge(controller, answers('warm'));
  host.composerValue = 'I lean closer.'; await controller.directorSend();
  host.chat().splice(-2, 2);
  await host.emit('MESSAGE_DELETED');
  assert.equal(controller.characterStateForUi()[0]?.meters[0].level, "friendly");
  const requests = scriptJudge(controller, answers('smitten'));
  host.composerValue = 'I lean in instead.'; await controller.directorSend();
  const state = requests.find((r: any) => 'meter_1_regard' in r.questions);
  assert.ok(!Object.keys(state.questions.meter_1_regard.criteria).includes("smitten"));
});
