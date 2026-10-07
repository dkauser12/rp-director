import { test } from 'node:test';
import { sim2, assert } from './support/phase3b-workflow.ts';

test('C3: a kept NPC permit enables decisions guards after the player-move stage failed', async t => {
  const sim = await sim2({ configure: s => {
    s.controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false, pacing: false, replyCheck: false };
    s.controller.settings.reactions.enabled = false;
    s.controller.settings.reviewNpcRolls = false;
  } });
  t.after(() => sim.controller.destroy());
  const base = sim.controller.provider();
  sim.controller.provider = () => ({ ...base, evaluate: async (request: any, signal: AbortSignal) => {
    if (request.questions.move) throw new Error('The move request failed in the fixture');
    return base.evaluate(request, signal);
  } });
  const prompts: { decisions: string; active: string; injection: string }[] = [];
  const intercept = sim.controller.interceptor.bind(sim.controller);
  sim.controller.interceptor = async (...args: unknown[]) => {
    await intercept(...args);
    prompts.push({ decisions: sim.controller.getMacro('module::decisions'), active: sim.controller.getMacro('active'), injection: sim.host.injection });
  };
  sim.writer.push({ tool: 'auto' }, { text: 'The guide works on the gate lock.' });
  await sim.clickSend('I ask the guide to open the gate.');
  await sim.settle();
  assert.equal(prompts.length, 2, 'the writer continues after its reviewed NPC action');
  assert.equal(prompts[0]!.decisions, '', 'the failed player decision allows preset fallback');
  assert.match(prompts[1]!.injection, /\[Director turn permit — binding for this reply\]/, 'the successful permit reaches the recursive writer request');
  assert.equal(prompts[1]!.decisions, 'true', 'the kept NPC ruling takes precedence over the earlier failed move');
  assert.equal(prompts[1]!.active, 'true');
});
