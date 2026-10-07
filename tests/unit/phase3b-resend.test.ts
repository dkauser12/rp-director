/**
 * Repro: the rule says a ruling belongs to the user message (its cursor), and
 * only a message that was never ruled is judged. Deleting the exchange and
 * sending the identical text again lands on the same cursor, the interceptor
 * even finds the old attempt there, but Send always judges anew and the fresh
 * pending attempt wins: a new draw with no popup. Director Next behaves the same.
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

test('B1: delete the exchange and send the identical message again: the frozen ruling is reused', async () => {
  const { host, controller } = await harness();
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false } as any;
  controller.settings.reactions.enabled = false;
  controller.profile.resolutionMethod = 'sample';
  let n = 0;
  realWriter(host, controller, () => `Reply ${++n}.`);
  scriptJudge(controller, turn);
  host.composerValue = 'Open the gate for me.'; await controller.directorSend();
  const first = Object.values(controller.record.attempts).at(-1) as any;
  const firstDraw = controller.record.resolutions[first.resolutionId].draw;
  host.chat().splice(2, 2);
  await host.emit('MESSAGE_DELETED');
  const requests = scriptJudge(controller, turn);
  host.composerValue = 'Open the gate for me.'; await controller.directorSend();
  const second = Object.values(controller.record.attempts).at(-1) as any;
  console.log('same cursor:', first.cursorBefore === second.cursorBefore, '| judge requests:', requests.length,
    '| draws:', firstDraw, controller.record.resolutions[second.resolutionId]?.draw);
  assert.equal(first.cursorBefore, second.cursorBefore);
  assert.equal(second.resolutionId, first.resolutionId, 'BUG: the same user message at the same cursor got a new ruling');
});
