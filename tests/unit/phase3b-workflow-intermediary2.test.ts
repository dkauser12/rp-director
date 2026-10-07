/** Follow-on of intermediary.test.ts: a swipe of the final reply after a rejected prose-before-tool call. */
import { test } from 'node:test';
import { sim2, attempts, assert } from './support/phase3b-workflow.ts';

test('after a prose-before-tool turn, a swipe of the final reply keeps the ruling', async () => {
  const sim = await sim2();
  sim.writer.push({ tool: 'auto', prose: 'The guide reaches for the lock and' });
  await sim.clickSend('I nod. "Open the gate, please."');
  await sim.swipeRight();
  await sim.settle();
  const last = sim.envelopes.at(-1) as any;
  console.log('swipe request:', last.type, '| ruling injected:', /Director ruling/.test(last.injection), '|', attempts(sim));
  assert.match(last.injection, /Director ruling/);
});
