/** Item 11: the NPC tool in a swipe-bound turn (a swipe of a pre-Director reply) under ST's tool loop. */
import { test } from 'node:test';
import { sim2, attempts, assert } from './support/phase3b-workflow.ts';

const RULING = /\[Director ruling — binding for this reply\]/;

for (const streaming of [true, false]) {
  test(`item 11 (${streaming ? 'streaming' : 'non-streaming'}): swipe of a pre-Director reply, writer calls the tool, follow-up keeps ruling + permit`, async () => {
    const sim = await sim2({ streaming });
    // The seeded chat [user, pre-Director reply]; swipe the reply.
    sim.writer.push({ tool: 'auto' });
    await sim.swipeRight();
    await sim.settle();
    const requests = sim.envelopes.map((e: any) => `${e.type}@${e.depth}${RULING.test(e.injection) ? ' ruling' : ''}${/turn permit/.test(e.injection) ? ' permit' : ''}${/tool result\]/.test(e.injection) ? ' refused' : ''}`);
    console.log('writer requests:', requests);
    console.log('attempts:', attempts(sim));
    console.log('chat:', sim.host.chat().map((m: any) => `${m.is_user ? 'U' : m.is_system ? 'T' : 'A'}:${JSON.stringify(m.mes.slice(0, 24))}${m.extra?.rpd ? '*' : ''}`).join(' '));
    console.log('tool log:', sim.log.filter(l => /tool/.test(l)).join(' | '));
    const final = sim.envelopes.at(-1) as any;
    assert.match(final.injection, /turn permit/, 'the follow-up carries the permit');
  });
}
