/**
 * Item 2: Stop mid-stream. ST's stopGeneration emits GENERATION_ENDED at once; the partial
 * reply's MESSAGE_RECEIVED comes only after onFinishStreaming -> finalizeIntermediaryMessage,
 * whose onProgressStreaming(final) awaits the token count (server tokenizer when
 * "Message Token Count" is on) and the reasoning handler.
 */
import { test } from 'node:test';
import { sim2, attempts, assert, permissiveJudge, turnScript, GUIDE } from './support/phase3b-workflow.ts';

for (const finalizeDelayMs of [0, 10]) {
  test(`Stop mid-stream (finalize work ${finalizeDelayMs} ms): the kept partial reply is completed (marker, judged meters)`, async () => {
    const sim = await sim2({ streaming: true, configure: s => { s.controller.settings.modules.meters = true; } });
    const requests = permissiveJudge(sim.controller, turnScript(GUIDE));
    sim.writer.push({ text: 'The guide starts to', delayMs: 60, finalizeDelayMs });
    sim.host.composerValue = 'I nod. "Open the gate, please."';
    sim.els.get('send_but')!.click();
    await new Promise(r => setTimeout(r, 25));
    sim.stop(); // user presses Stop while streaming
    await sim.settle();
    const partial = sim.host.chat().at(-1)!;
    console.log(`[${finalizeDelayMs}ms] after Stop:`, attempts(sim), '| partial reply marked:', Boolean(partial.extra?.rpd), '| log:', sim.log.slice(-5).join(' | '));
    requests.length = 0;
    await sim.clickSend('I wait. "Well?"');
    const meter = requests.flatMap((r: any) => Object.entries(r.questions)).find(([id]) => id.startsWith('meter_')) as any;
    console.log(`[${finalizeDelayMs}ms] next turn meter question:`, /No level has been judged yet/.test(meter?.[1]?.instructions) ? 'first assessment again' : /Before the latest exchange [^.]*/.exec(meter?.[1]?.instructions ?? '')?.[0]);
    assert.ok(partial.extra?.rpd, 'the partial reply the user kept is completed');
    assert.doesNotMatch(meter?.[1]?.instructions ?? '', /No level has been judged yet/);
  });
}
