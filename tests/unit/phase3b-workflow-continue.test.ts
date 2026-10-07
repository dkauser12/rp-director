/** Continue (manual or ST auto-continue) of a ruled reply. Non-streaming continue emits MESSAGE_RECEIVED(id, 'appendFinal'). */
import { test } from 'node:test';
import { sim2, attempts, assert, permissiveJudge, turnScript, GUIDE } from './support/phase3b-workflow.ts';

for (const streaming of [true, false]) {
  test(`continue (${streaming ? 'streaming' : 'non-streaming'}): the continued reply keeps a completed attempt and the turn's meters`, async () => {
    const sim = await sim2({ streaming, configure: s => { s.controller.settings.modules.meters = true; } });
    const requests = permissiveJudge(sim.controller, turnScript(GUIDE));
    await sim.clickSend('I nod. "Open the gate, please."');
    sim.writer.push({ text: 'And then some more.' });
    sim.sendPress = true; // ST option_continue handler
    await sim.generate('continue');
    await sim.settle();
    const reply = sim.host.chat().at(-1)!;
    console.log(`[${streaming ? 'stream' : 'no-stream'}]`, attempts(sim), '| reply:', JSON.stringify(reply.mes.slice(0, 50)));
    requests.length = 0;
    await sim.clickSend('I wait. "Well?"');
    const meter = requests.flatMap((r: any) => Object.entries(r.questions)).find(([id]) => id.startsWith('meter_')) as any;
    const baseline = /No level has been judged yet/.test(meter?.[1]?.instructions) ? 'first assessment again' : /Before the latest exchange [^.]*/.exec(meter?.[1]?.instructions ?? '')?.[0];
    console.log(`[${streaming ? 'stream' : 'no-stream'}] next turn meter baseline:`, baseline);
    assert.doesNotMatch(meter?.[1]?.instructions ?? '', /No level has been judged yet/, 'the continued turn\'s judged meters survive');
  });
}
