import { test } from 'node:test';
import { sim2, attempts, lastMarker, assert } from './support/phase3b-workflow.ts';

for (const streaming of [true, false]) {
  test(`smoke (${streaming ? 'streaming' : 'non-streaming'}): a Director Send is ruled, marked and swipes reuse it`, async () => {
    const sim = await sim2({ streaming });
    await sim.clickSend('I nod. "Open the gate, please."');
    console.log(attempts(sim), sim.log.join(' | '));
    assert.equal(sim.host.chat().length, 4);
    assert.ok(lastMarker(sim), 'reply marked');
    const first = sim.envelopes.at(-1) as any;
    assert.match(first.injection, /Director ruling/);
    assert.ok((first.envelope as any).tools, 'tools offered');
    await sim.swipeRight();
    await sim.settle();
    console.log(attempts(sim));
    const swipe = sim.envelopes.at(-1) as any;
    assert.equal(swipe.type, 'swipe');
    assert.match(swipe.injection, /Director ruling/);
    assert.deepEqual(swipe.envelope, first.envelope, 'same tools on the swipe');
    assert.ok(lastMarker(sim));
  });
}
