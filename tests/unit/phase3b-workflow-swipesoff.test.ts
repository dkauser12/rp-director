/** ST "Swipes" setting off: the Director falls back to Generate('regenerate'). */
import { test } from 'node:test';
import { sim2, attempts, assert } from './support/phase3b-workflow.ts';

test('swipes off: Roll again regenerates with the new draw; menu Regenerate stays native and reuses the ruling', async () => {
  const sim = await sim2();
  await sim.clickSend('I nod. "Open the gate, please."');
  sim.els.get('swipes-checkbox')!.checked = false;
  const r0 = sim.host.chat().at(-1)!.extra?.rpd?.r;
  const ok = await sim.controller.reroll(true);
  await sim.settle();
  const r1 = sim.host.chat().at(-1)!.extra?.rpd?.r;
  console.log('reroll ok', ok, '| ruling', r0, '->', r1, '|', attempts(sim), '| last request', (sim.envelopes.at(-1) as any).type);
  assert.notEqual(r1, r0);
  await sim.menuRegenerate();
  const r2 = sim.host.chat().at(-1)!.extra?.rpd?.r;
  console.log('menu regenerate ->', r2, '| last request', (sim.envelopes.at(-1) as any).type, /Director ruling/.test((sim.envelopes.at(-1) as any).injection));
  assert.equal(r2, r1);
});
