import { test } from 'node:test';
import assert from 'node:assert/strict';
const ROOT = new URL('../../', import.meta.url).href;
const { actorIdFor } = await import(ROOT + 'src/identity.ts');
const { choice, harness, noul, scriptJudge } = await import(ROOT + 'tests/unit/support/test-host.ts');

const GUIDE = actorIdFor('Guide', 'guide.png');
const turn = {
  move: choice('s1'), move_count: choice('one'), owner: choice('player'), target: choice(GUIDE),
  family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'), ruling: noul(0.45),
};

/** Like ST: Generate posts the composer text as the user message before the interceptor runs. */
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

async function ready(modules: Record<string, boolean>, pack = 'default') {
  const h = await harness();
  h.controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false, ...modules } as any;
  h.controller.settings.reactions.enabled = false;
  await h.controller.setChatPack(pack);
  return h;
}

test('T1: editing a reply then swiping keeps its user-message ruling and asks once', async () => {
  const { host, controller } = await ready({});
  controller.settings.askWhenSwiping = true;
  let prompts = 0;
  host.swipeResult = async () => { prompts++; return 'reuse'; };
  scriptJudge(controller, turn);
  realWriter(host, controller, () => 'Original reply.');
  host.composerValue = 'Open the gate for me.';
  await controller.directorSend();
  assert.equal(Object.keys(controller.record.resolutions).length, 1);
  const message = host.chat().at(-1);
  message.mes = 'Original reply, typo fixed.'; message.swipes[0] = message.mes;
  await host.emit('MESSAGE_EDITED', host.chat().length - 1);
  const requests = scriptJudge(controller, turn);
  message.swipe_id = message.swipes.length;
  await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
  await controller.interceptor([], 4096, () => assert.fail('abort'), 'swipe');
  assert.equal(requests.length, 0); assert.equal(Object.keys(controller.record.resolutions).length, 1); assert.equal(prompts, 1);
});

test('T2: an edited wording swipe preserves judged meters without another request', async () => {
  const { host, controller } = await ready({ decisions: false, meters: true }, 'romance');
  const answers = (regard: string) => ({ move: choice('NONE'), move_count: choice('one'), meter_1_regard: choice(regard), meter_1_nerve: choice('steady') });
  let n = 0;
  realWriter(host, controller, () => `Reply ${++n}.`);
  scriptJudge(controller, answers('friendly'));
  host.composerValue = 'Hello.'; await controller.directorSend();
  scriptJudge(controller, answers('warm'));
  host.composerValue = 'I lean closer.'; await controller.directorSend();
  assert.equal(controller.characterStateForUi()[0]?.meters[0].level, "warm");
  const message = host.chat().at(-1);
  message.mes = 'Reply 2, edited.'; message.swipes[0] = message.mes;
  await host.emit('MESSAGE_EDITED', host.chat().length - 1);
  const requests = scriptJudge(controller, answers('smitten'));
  message.swipe_id = message.swipes.length;
  await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
  const state = requests.find((r: any) => 'meter_1_regard' in r.questions);
  assert.equal(requests.length, 0);
  assert.equal(controller.characterStateForUi()[0]?.meters[0].level, "warm");
});

test('T3: a legacy reassessment uses pre-turn meters and leaves its original variant unchanged', async () => {
  const { host, controller } = await ready({ decisions: false, meters: true }, 'romance');
  const answers = (regard: string) => ({ move: choice('NONE'), move_count: choice('one'), meter_1_regard: choice(regard), meter_1_nerve: choice('steady') });
  let n = 0;
  realWriter(host, controller, () => `Reply ${++n}.`);
  scriptJudge(controller, answers('friendly'));
  host.composerValue = 'Hello.'; await controller.directorSend();
  scriptJudge(controller, answers('warm'));
  host.composerValue = 'I lean closer.'; await controller.directorSend();
  // Make the last turn look like a 0.7 record: no per-attempt story fields, no snapshot at cursorAfter.
  const last = Object.values(controller.record.attempts).at(-1) as any;
  const variant = controller.record.variants[last.variantId];
  for (const key of ['storyBefore', 'storyAfter', 'frozenStateBlock', 'frozenSpeaker', 'frozenLorePlan', 'judgeErrors']) delete last[key];
  delete controller.record.story.history[variant.cursorAfter];
  const message = host.chat().at(-1);
  const originalText = message.mes; const originalExtra = structuredClone(message.extra);
  assert.equal(controller.characterStateForUi()[0]?.meters[0].level, "friendly");
  const requests = scriptJudge(controller, answers('smitten'));
  host.swipeRight = async () => {
    message.swipe_id = message.swipes.length;
    await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
    await controller.interceptor([], 4096, () => assert.fail('abort'), 'swipe');
    message.mes = 'Retried reply.'; message.swipes.push(message.mes);
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'swipe');
  };
  controller.settings.modules.decisions = true;
  await controller.reassess(true);
  const state = requests.find((r: any) => 'meter_1_regard' in r.questions);
  assert.ok(state, "legacy reassessment asks from its pre-turn snapshot"); assert.ok(!Object.keys(state.questions.meter_1_regard.criteria).includes("smitten"));
  assert.equal(controller.characterStateForUi()[0]?.meters[0].level, "friendly");
  message.swipe_id = 0; message.mes = originalText; message.extra = originalExtra;
  await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
  assert.equal(controller.characterStateForUi()[0]?.meters[0].level, "friendly");
});

test('T5: regenerating an unruled later user message cannot reuse an earlier ruling', async () => {
  const { host, controller } = await ready({});
  scriptJudge(controller, turn);
  realWriter(host, controller, () => 'Ruled reply.');
  host.composerValue = 'Open the gate for me.';
  await controller.directorSend();
  const ruled = Object.values(controller.record.attempts).at(-1) as any;
  // Browse the ruled reply's swipes (no generation): records swipeSource.
  await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
  await controller.setPaused(true);
  host.chat().push({ name: 'Player', is_user: true, is_system: false, mes: 'I wander off.' });
  await controller.interceptor([], 4096, () => {}, 'normal');
  host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: 'Native reply.', swipe_id: 0, swipes: ['Native reply.'], swipe_info: [{ extra: {} }] });
  await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal');
  await controller.setPaused(false);
  const requests = scriptJudge(controller, turn);
  await host.emit('GENERATION_STARTED', 'regenerate');
  host.chat().pop();
  await controller.interceptor([], 4096, () => {}, 'regenerate');
  const now = Object.values(controller.record.attempts).at(-1) as any;
  assert.ok(requests.length > 0); assert.notEqual(now.resolutionId, ruled.resolutionId);
});
