import { test } from 'node:test';
import assert from 'node:assert/strict';
const ROOT = new URL('../../', import.meta.url).href;
const { actorIdFor } = await import(ROOT + 'src/identity.ts');
const { choice, harness, noul, scriptJudge } = await import(ROOT + 'tests/unit/support/test-host.ts');
const GUIDE = actorIdFor('Guide', 'guide.png');

function realWriter(host: any, controller: any, prose: () => string) {
  host.context.generate = async (_type: string, options?: Record<string, unknown>) => {
    host.generated.push(options ?? {});
    if (host.composerValue) { host.chat().push({ name: 'Player', is_user: true, is_system: false, mes: host.composerValue }); host.composerValue = ''; }
    await controller.interceptor([], 4096, () => assert.fail('unexpected abort'), 'normal');
    const text = prose();
    host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }] });
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal');
  };
}

test('T6: Reassess on a Next reply judges its own exchange from its own baseline', async () => {
  const h = await harness();
  const { host, controller } = h as any;
  controller.settings.modules = { speaker: false, decisions: false, meters: true, secrets: false, lore: false } as any;
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('romance');
  const answers = (regard: string) => ({ move: choice('NONE'), move_count: choice('one'), meter_1_regard: choice(regard), meter_1_nerve: choice('steady') });
  let n = 0;
  realWriter(host, controller, () => `Reply ${++n}.`);
  scriptJudge(controller, answers('friendly'));
  host.composerValue = 'Hello.'; await controller.directorSend();
  scriptJudge(controller, answers('warm'));
  host.composerValue = 'I lean closer.'; await controller.directorSend();
  scriptJudge(controller, answers('warm'));
  await controller.directorNext();
  
  const message = host.chat().at(-1);
  const requests = scriptJudge(controller, answers('smitten'));
  host.swipeRight = async () => {
    message.swipe_id = message.swipes.length;
    await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
    await controller.interceptor([], 4096, () => assert.fail('abort'), 'swipe');
    message.mes = 'Retried.'; message.swipes.push(message.mes);
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'swipe');
  };
  controller.settings.modules.decisions = true;
  await controller.reassess(true);
  const state = requests.find((r: any) => 'meter_1_regard' in r.questions);
  assert.equal(state?.snapshot.state.latestInput, ""); assert.ok(state?.snapshot.state.recentAcceptedMessages.some((m:any)=>m.text === "Reply 2."));
  assert.deepEqual(Object.keys(state.questions.meter_1_regard.criteria), ["friendly", "warm", "smitten"]);
});

test('T10: all modules off makes reroll inert with zero requests', async () => {
  const h = await harness();
  const { host, controller } = h;
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false } as any;
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('default');
  const turn = { move: choice('s1'), move_count: choice('one'), owner: choice('player'), target: choice(GUIDE), family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'), ruling: noul(0.45) };
  scriptJudge(controller, turn);
  realWriter(host, controller, () => 'Ruled.');
  host.composerValue = 'Open the gate for me.'; await controller.directorSend();
  controller.settings.modules = { speaker: false, decisions: false, meters: false, secrets: false, lore: false } as any;
  const requests = scriptJudge(controller, turn);
  host.swipeRight = async () => {};
  const ok = await controller.reroll(false);
  assert.equal(ok, false); assert.equal(requests.length, 0);
});
