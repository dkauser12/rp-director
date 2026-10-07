/** Try the judge again on a turn whose writer used the NPC tool (tool message between the user message and the reply). */
import { test } from 'node:test';
import { sim2, attempts, assert, turnScript, GUIDE } from './support/phase3b-workflow.ts';
import { choice, noul } from './support/phase3b-st-harness.ts';

test('retry after an NPC-tool turn: bound to the tool-message cursor, user message judged twice, kept permit not injected', async () => {
  const sim = await sim2();
  const script: Record<string, unknown> = turnScript(GUIDE);
  const original = sim.controller.provider.bind(sim.controller);
  let failRoute = true;
  const requests: any[] = [];
  sim.controller.provider = () => ({ ...original(), evaluate: async (request: any) => {
    const ids = Object.keys(request.questions);
    requests.push(structuredClone(request));
    if (failRoute && ids.includes('owner')) throw new Error('network down');
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries<any>(request.questions)) answers[id] = script[id] ?? (q.type === 'choice' ? choice(Object.keys(q.criteria)[0]!) : noul(0.5));
    return { requestId: request.requestId, provider: 'mock', requestedModel: null, returnedModel: 'fixture', answers, unresolvedQuestionIds: [], errors: {}, inputTokens: null, outputTokens: null, durationMs: 1, transportAttempts: 1 };
  } });
  sim.writer.push({ tool: 'auto' });
  await sim.clickSend('I nod. "Open the gate, please."');
  const rec = sim.controller.record;
  const first = Object.values<any>(rec.attempts).at(-1);
  console.log('turn 1:', attempts(sim), '| permit kept:', Boolean(first.permitId), '| retry eligible:', sim.host.chat().at(-1)!.extra?.rpdWorkflow?.retryEligible);
  failRoute = false;
  requests.length = 0;
  await sim.controller.retryJudge();
  await sim.settle();
  const retry = Object.values<any>(sim.controller.record.attempts).sort((a, b) => a.createdAt - b.createdAt).at(-1);
  const moveRequest = requests.find(r => r.questions.owner);
  const history = moveRequest?.snapshot?.state?.recentAcceptedMessages ?? [];
  const lastHistory = history.at(-1)?.text;
  const writer = sim.envelopes.at(-1) as any;
  console.log('retry attempt:', attempts(sim).at(-1), '| same cursor as turn 1:', retry.cursorBefore === first.cursorBefore);
  console.log('judge latestInput:', JSON.stringify(moveRequest?.snapshot?.state?.latestInput), '| last history message:', JSON.stringify(lastHistory));
  console.log('retry attempt permitId:', retry.permitId, '| permit in retry writer injection:', /turn permit/.test(writer.injection), '| tool checkpoint offered again:', /NPC-action checkpoint/.test(writer.injection));
  assert.equal(retry.cursorBefore, first.cursorBefore, 'the retry belongs to the same user message');
  assert.notEqual(lastHistory, 'I nod. "Open the gate, please."', 'the judged input must not also appear as history');
  if (retry.permitId) assert.match(writer.injection, /turn permit/, 'a kept permit must reach the writer if the attempt claims it');
});
