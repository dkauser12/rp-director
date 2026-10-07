import { test } from 'node:test';
import { assert, sim2, lastMarker } from './support/phase3b-workflow.ts';

test('3b/16: automatic reply correction survives a refused tool and retains the cache-stable envelope', async t => {
  const sim = await sim2({ configure: s => { s.controller.settings.modules.replyCheck = true; } });
  t.after(() => sim.controller.destroy());
  const provider = sim.controller.provider();
  let checks = 0;
  sim.controller.provider = () => ({ ...provider, evaluate: async (request: any, signal: AbortSignal) => {
    const result = await provider.evaluate(request, signal);
    if (request.questions.speaks_for_user) {
      checks++;
      const score = (value: number) => ({ type: 'score', score: value, probabilities: null, legend: {}, confidence: null, provenance: 'fixture' });
      Object.assign(result.answers, { speaks_for_user: score(checks === 1 ? 4 : 0), responds: score(2), repeats: score(0),
        follows_ruling: { type: 'noul', noul: 1, confidence: null, provenance: 'fixture' } });
    }
    return result;
  } });
  const prompts: any[][] = [];
  const interceptor = sim.controller.interceptor.bind(sim.controller);
  sim.controller.interceptor = async (...args: any[]) => {
    await interceptor(...args);
    prompts.push(structuredClone(args[0]));
  };
  sim.host.swipeResult = async () => assert.fail('automatic correction must keep the ruling without a popup');
  sim.writer.push({ text: 'The guide speaks for the player.' }, { tool: 'auto' }, { text: 'The guide waits for an answer.' });
  const input = 'I nod. "Open the gate, please."';
  await sim.clickSend(input);
  await sim.settle();
  assert.equal(sim.envelopes.length, 3);
  assert.deepEqual(sim.envelopes[0]!.envelope, sim.envelopes[1]!.envelope);
  assert.deepEqual(sim.envelopes[1]!.envelope, sim.envelopes[2]!.envelope);
  const attempts = Object.values<any>(sim.controller.record.attempts);
  assert.equal(attempts.length, 2, 'refusal recursion continues the automatic attempt');
  assert.equal(attempts[0].resolutionId, attempts[1].resolutionId);
  assert.equal(lastMarker(sim).a, attempts[1].attemptId);
  assert.match((sim.envelopes[2] as any).injection, /Director ruling/);
  assert.match((sim.envelopes[2] as any).injection, /tool is closed/);
  assert.ok(attempts[1].replyCorrection);
  for (const envelope of sim.envelopes.slice(1)) assert.ok((envelope as any).injection.includes(attempts[1].replyCorrection));
  for (const prompt of prompts) assert.equal(prompt.filter((message: any) => message.is_user).at(-1).mes, input);
  assert.equal(sim.host.chat().findLast((message: any) => message.is_user).mes, input);
});
