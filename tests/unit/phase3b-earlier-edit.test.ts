/**
 * Repro: the cursor of the latest user message includes every earlier message.
 * Editing an EARLIER reply (a typo fix two turns back) moves that cursor, so
 * the latest exchange's frozen ruling is no longer found: the next swipe of the
 * latest reply is re-judged with a new draw and no popup, its badge disappears,
 * and the meters shown at the head fall back to the edited turn's snapshot.
 */
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
  h.controller.profile.resolutionMethod = 'sample';
  await h.controller.setChatPack(pack);
  return h;
}

test('E1: editing an earlier reply, then swiping the latest reply, keeps the latest ruling', async () => {
  const { host, controller } = await ready({});
  controller.settings.askWhenSwiping = true;
  let prompts = 0;
  host.swipeResult = async () => { prompts++; return 'reuse'; };
  let n = 0;
  scriptJudge(controller, turn);
  realWriter(host, controller, () => `Reply ${++n}.`);
  host.composerValue = 'Open the gate for me.'; await controller.directorSend();
  host.composerValue = 'I push past the guard.'; await controller.directorSend();
  const latest = Object.values(controller.record.attempts).at(-1) as any;
  const frozen = controller.record.resolutions[latest.resolutionId];
  assert.ok(frozen, 'the latest exchange is ruled');
  assert.ok(host.readWorkflowBadge(host.chat().length - 1), 'the latest reply has a badge');

  // A cosmetic edit of the EARLIER reply (index 3).
  const earlier = host.chat()[3];
  earlier.mes = 'Reply 1, typo fixed.'; earlier.swipes[0] = earlier.mes;
  await host.emit('MESSAGE_EDITED', 3);
  console.log('badge on the latest reply after the edit:', host.readWorkflowBadge(host.chat().length - 1) ? 'present' : 'REMOVED');
  console.log('canRerollSelected after the edit:', controller.canRerollSelected());

  const requests = scriptJudge(controller, turn);
  const message = host.chat().at(-1);
  message.swipe_id = message.swipes.length;
  await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
  await controller.interceptor([], 4096, () => assert.fail('abort'), 'swipe');
  const now = Object.values(controller.record.attempts).at(-1) as any;
  const used = controller.record.resolutions[now.resolutionId];
  console.log('judge requests on the wording swipe:', requests.length, '| popups:', prompts,
    '| draw before/after:', frozen.draw, used?.draw, '| same resolution:', now.resolutionId === latest.resolutionId);
  assert.equal(requests.length, 0, 'BUG: the wording swipe was re-judged');
  assert.equal(now.resolutionId, latest.resolutionId, 'BUG: the wording swipe carries a new ruling');
});

test('E2: editing an earlier reply does not roll the head meters back a turn', async () => {
  const { host, controller } = await ready({ decisions: false, meters: true }, 'romance');
  const answers = (regard: string) => ({ move: choice('NONE'), move_count: choice('one'), meter_1_regard: choice(regard), meter_1_nerve: choice('steady') });
  let n = 0;
  realWriter(host, controller, () => `Reply ${++n}.`);
  scriptJudge(controller, answers('friendly'));
  host.composerValue = 'Hello.'; await controller.directorSend();
  scriptJudge(controller, answers('warm'));
  host.composerValue = 'I lean closer.'; await controller.directorSend();
  assert.equal(controller.characterStateForUi()[0]?.meters[0].level, 'warm');
  const earlier = host.chat()[3];
  earlier.mes = 'Reply 1, typo fixed.'; earlier.swipes[0] = earlier.mes;
  await host.emit('MESSAGE_EDITED', 3);
  const shown = controller.characterStateForUi()[0]?.meters[0].level;
  console.log('head meter after editing reply 1:', shown);
  // The next Send would judge from this baseline.
  const requests = scriptJudge(controller, answers('warm'));
  host.composerValue = 'And then?'; await controller.directorSend();
  const state = requests.find((r: any) => 'meter_1_regard' in r.questions);
  console.log('next turn asks from:', state.questions.meter_1_regard.instructions.match(/was "[^"]+"/)?.[0]);
  assert.equal(shown, 'warm', 'BUG: turn 2\'s judged meter step was dropped from the head');
});
