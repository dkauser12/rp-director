/** GENERATION_STARTED is also emitted for dry runs (script.js 4299: 4th arg dryRun); the Director ignores the flag. */
import { test } from 'node:test';
import { sim2, attempts, assert } from './support/phase3b-workflow.ts';

test('a dry-run Generate (e.g. another extension\'s prompt preview) during a live writer cancels the live attempt', async () => {
  const sim = await sim2({ streaming: true });
  sim.writer.push({ text: 'A long streamed reply.', delayMs: 40 });
  sim.host.composerValue = 'I nod. "Open the gate, please."';
  sim.els.get('send_but')!.click();
  await new Promise(r => setTimeout(r, 20));
  const live = attempts(sim);
  await sim.host.emit('GENERATION_STARTED', 'normal', {}, true); // dry run: no interceptors, no GENERATION_ENDED
  await sim.settle();
  console.log('live before dry run:', live, '| after:', attempts(sim), '| reply marked:', Boolean(sim.host.chat().at(-1)!.extra?.rpd));
  assert.ok(sim.host.chat().at(-1)!.extra?.rpd, 'a dry run must not cancel the live writer attempt');
});
