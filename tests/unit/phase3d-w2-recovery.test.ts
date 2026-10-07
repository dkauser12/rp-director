/**
 * W2 after 3c: errors are keyed `${stage}:${type}` and cleared by
 * recoverJudgeStage(stage).
 *
 * 1. stagedTurn() reports an invalid NPC-reaction answer (it rides in the move
 *    request) under the 'move' key but records the failed stage as 'reaction'
 *    (controller.ts ~802-803). The recovery loop (~943) then sees 'move' asked and
 *    not failed and clears `move:*` in the same turn, so the same failure toasts
 *    again on every turn. (The same happens to 'speaker' and 'ruling' failures
 *    reported after that loop, ~972 and ~1035.)
 * 2. recoverJudgeStage() clears lastError but never refreshes `status`. After a
 *    reply-check failure, the next completed reply sets status 'Error'
 *    (completeMessage -> refreshStatus); its successful check then clears
 *    lastError while status stays 'Error', so the drawer chip keeps saying
 *    "Judge unavailable" after the stage recovered.
 */
import { test } from 'node:test';
import { sim2, assert } from './support/phase3b-workflow.ts';
import { rc, score, until } from './support/phase3c-replycheck.ts';
import { buildStatusChip } from '../../src/status-chip.ts';

test('W2: a persistent invalid NPC-reaction answer toasts once, not on every turn', async t => {
  const sim: any = await sim2();
  t.after(() => sim.controller.destroy());
  sim.controller.settings.reactions.enabled = true;
  const base = sim.controller.provider.bind(sim.controller);
  sim.controller.provider = () => {
    const provider = base();
    return { ...provider, evaluate: async (request: any, signal: AbortSignal) => {
      const result = await provider.evaluate(request, signal);
      if ('npc_reaction_1' in request.questions) {
        result.answers = { ...result.answers, npc_reaction_1: { type: 'choice', choice: 'NOT_AN_OPTION', probabilities: null, confidence: null, provenance: 'fixture' } };
      }
      return result;
    } };
  };
  await sim.clickSend('I nod. "Open the gate, please."');
  await sim.clickSend('I nod again. "Thank you, guide."');
  const toasts = sim.host.notices.filter((notice: string) => notice.includes('npc_reaction_1'));
  console.log(toasts);
  assert.ok(toasts.length >= 1, 'sanity: the failure was reported');
  assert.equal(toasts.length, 1, 'one toast for this error type until the stage recovers');
});

test('W2: once the reply check recovers, the drawer no longer reports an error', async t => {
  let checks = 0;
  const h = await rc({ answers: request => ('speaks_for_user' in request.questions ? { speaks_for_user: score(0) } : {}) });
  t.after(() => h.controller.destroy());
  const provider = h.controller.provider.bind(h.controller);
  h.controller.provider = () => {
    const base = provider();
    return { ...base, evaluate: async (request: any, signal: AbortSignal) => {
      if ('speaks_for_user' in request.questions && ++checks === 1) throw new Error('network: the judge is unreachable');
      return base.evaluate(request, signal);
    } };
  };
  await h.sim.clickSend('I nod. "Open the gate, please."');
  await until(() => h.host.notices.some((notice: string) => notice.includes('Reply check unavailable')), 'the first check failed');
  await h.sim.swipeRight(); // a wording swipe; its check succeeds
  await until(() => checks === 2, 'the second check ran');
  await h.sim.settle();
  const chip = buildStatusChip({ enabled: true, paused: false, hasChat: true, status: h.controller.status, lastError: h.controller.lastError,
    connectionConfigured: true, connectionWorking: true });
  console.log(`status ${h.controller.status}; lastError ${h.controller.lastError}; chip ${chip.label}`);
  assert.equal(h.controller.lastError, null, 'sanity: the reply-check error was cleared');
  assert.notEqual(h.controller.status, 'Error', 'status follows the recovery');
  assert.equal(chip.state, 'ready');
});

test('W2: a refused writer tool call toasts once; a wording swipe that never offered the tool is not a recovery', async t => {
  const sim: any = await sim2();
  t.after(() => sim.controller.destroy());
  const refused = "The writer's move could not be ruled. Your chat isn't affected.";
  sim.writer.push({ tool: 'auto', prose: 'The guide starts to answer.' }, { text: 'The guide answers.' });
  await sim.clickSend('I nod. "Open the gate, please."');
  assert.equal(sim.host.notices.filter((notice: string) => notice === refused).length, 1, 'sanity: the refusal toasted');
  await sim.swipeRight(); await sim.settle(); // a wording swipe; the tool is closed for it
  sim.writer.push({ tool: 'auto', prose: 'The guide starts again.' }, { text: 'The guide answers again.' });
  await sim.clickSend('I nod again. "Thank you, guide."');
  const toasts = sim.host.notices.filter((notice: string) => notice === refused);
  console.log(`refusal toasts: ${toasts.length}`, '|', sim.log.filter((line: string) => line.startsWith('tool')).join(' | '));
  assert.equal(toasts.length, 1, 'the same refusal type toasts once until a tool call is accepted');
});
