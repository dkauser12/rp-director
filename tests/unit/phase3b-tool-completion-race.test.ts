import { test } from 'node:test';
import { assert, sim2 } from './support/phase3b-workflow.ts';

test('3b/16/21/23: a slower later message listener cannot complete tool prose before native recursion', async () => {
  const sim = await sim2();
  await sim.clickSend('I nod. "Open the gate, please."');
  sim.host.context.eventSource.on('MESSAGE_RECEIVED', async () => new Promise(resolve => setTimeout(resolve, 15)));
  const initialResolution = sim.host.chat().at(-1)!.extra!.rpd.r;
  sim.writer.push({ tool: 'auto', prose: 'Intermediary prose before the tool.' });
  await sim.swipeRight();
  await sim.settle();
  const final = sim.envelopes.at(-1) as typeof sim.envelopes[number] & { injection: string };
  assert.match(final.injection, /\[Director ruling — binding for this reply\]/);
  assert.match(final.injection, /tool is closed/);
  assert.equal(sim.host.chat().at(-1)!.extra?.rpd?.r, initialResolution);
  const selected = sim.controller.record.attempts[sim.host.chat().at(-1)!.extra?.rpd?.a];
  assert.equal(selected?.hostMessageRef, sim.host.chat().length - 1);
});
