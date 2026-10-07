/** Writer prose before the tool call: ST keeps the intermediary message; which message gets the attempt? */
import { test } from 'node:test';
import { sim2, attempts, assert } from './support/phase3b-workflow.ts';

for (const streaming of [true, false]) {
  test(`prose before the tool (${streaming ? 'streaming' : 'non-streaming'}): the final reply, not the intermediary, is marked`, async () => {
    const sim = await sim2({ streaming });
    sim.writer.push({ tool: 'auto', prose: 'The guide reaches for the lock and' });
    await sim.clickSend('I nod. "Open the gate, please."');
    const chat = sim.host.chat();
    console.log('chat:', chat.map((m: any) => `${m.is_user ? 'U' : m.is_system ? 'T' : 'A'}:${JSON.stringify(m.mes.slice(0, 22))}${m.extra?.rpd ? ' [marked]' : ''}`).join(' '));
    console.log('attempts:', attempts(sim), '| log:', sim.log.filter(l => /tool/.test(l)).map(l => l.slice(0, 70)).join(' | '));
    assert.ok(chat.at(-1)!.extra?.rpd, 'the final reply carries the attempt marker');
    assert.equal(chat.at(-3)!.extra?.rpd, undefined, 'the rejected intermediary prose is not the attempt\'s reply');
  });
}
