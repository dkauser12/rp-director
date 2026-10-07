/**
 * Repro: a failed writer leaves its frozen ruling on an attempt with no reply
 * marker; compaction keeps it only while its cursor is on the live chain. A
 * transient edit of the user message (typo fixed, then reverted) takes that
 * cursor off the chain for one save, compaction drops the attempt and its
 * resolution, and the reverted message is then judged again with new dice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
const ROOT = new URL('../../', import.meta.url).href;
const { actorIdFor } = await import(ROOT + 'src/identity.ts');
const { choice, harness, noul, scriptJudge } = await import(ROOT + 'tests/unit/support/test-host.ts');
const GUIDE = actorIdFor('Guide', 'guide.png');
const turn = { move: choice('s1'), move_count: choice('one'), owner: choice('player'), target: choice(GUIDE), family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'), ruling: noul(0.45) };

test('K1: an edit-and-revert elsewhere does not discard a failed writer\'s frozen ruling', async () => {
  const { host, controller } = await harness();
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false } as any;
  controller.settings.reactions.enabled = false;
  controller.profile.resolutionMethod = 'sample';
  // The writer fails: the user message is posted, no reply arrives.
  host.context.generate = async () => {
    if (host.composerValue) { host.chat().push({ name: 'Player', is_user: true, is_system: false, mes: host.composerValue }); host.composerValue = ''; }
    await controller.interceptor([], 4096, () => assert.fail('abort'), 'normal');
    throw new Error('writer API error');
  };
  scriptJudge(controller, turn);
  host.composerValue = 'Open the gate for me.'; await controller.directorSend();
  const frozen = Object.values(controller.record.attempts).at(-1) as any;
  // Typo fix on the user message, then reverted.
  const user = host.chat().at(-1);
  user.mes = 'Open the gate for me!'; await host.emit('MESSAGE_EDITED', host.chat().length - 1);
  user.mes = 'Open the gate for me.'; await host.emit('MESSAGE_EDITED', host.chat().length - 1);
  console.log('frozen attempt still in record:', Boolean(controller.record.attempts[frozen.attemptId]), '| its resolution:', Boolean(controller.record.resolutions[frozen.resolutionId]));
  // Native retry (empty Send / regenerate) of the same user message.
  const requests = scriptJudge(controller, turn);
  host.context.generate = async () => {};
  await controller.interceptor([], 4096, () => assert.fail('abort'), 'normal');
  const now = Object.values(controller.record.attempts).at(-1) as any;
  console.log('judge requests on retry:', requests.length, '| same ruling:', now.resolutionId === frozen.resolutionId);
  assert.equal(now.resolutionId, frozen.resolutionId, 'BUG: compaction dropped the frozen ruling during the transient edit; the retry re-rolled');
});
