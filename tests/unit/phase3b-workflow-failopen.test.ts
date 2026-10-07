/** W2 fail-open and "Try the judge again" under ST's event order. */
import { test } from 'node:test';
import { sim2, attempts, lastMarker, assert, turnScript, GUIDE } from './support/phase3b-workflow.ts';
import { choice, noul } from './support/phase3b-st-harness.ts';

function flakyJudge(controller: any, failWhen: (ids: string[], call: number) => boolean) {
  const requests: any[] = [];
  const script: Record<string, unknown> = turnScript(GUIDE);
  const original = controller.provider.bind(controller);
  let call = 0;
  controller.provider = () => ({
    ...original(),
    evaluate: async (request: any) => {
      call += 1;
      const ids = Object.keys(request.questions);
      requests.push({ call, ids });
      if (failWhen(ids, call)) throw Object.assign(new Error('network down'), { code: 'network' });
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries<any>(request.questions)) {
        answers[id] = script[id] ?? (q.type === 'choice' ? choice(Object.keys(q.criteria)[0]!) : q.type === 'noul' ? noul(0.5)
          : { type: 'score', score: 0, legend: Object.fromEntries(q.criteria.map((c: string, i: number) => [String(i), c])), probabilities: null, confidence: null, provenance: 'fixture' });
      }
      return { requestId: request.requestId, provider: 'mock', requestedModel: null, returnedModel: 'fixture', answers, unresolvedQuestionIds: [], errors: {}, inputTokens: null, outputTokens: null, durationMs: 1, transportAttempts: 1 };
    },
  });
  return requests;
}

test('W2: a failed route stage fails open with one toast; Try the judge again replays the answered move and makes a new ruled swipe', async () => {
  const sim = await sim2({ configure: s => { s.controller.settings.modules.meters = true; } });
  let failRoute = true;
  const requests = flakyJudge(sim.controller, ids => failRoute && ids.includes('owner'));
  await sim.clickSend('I nod. "Open the gate, please."');
  const badge = sim.host.chat().at(-1)!.extra?.rpdWorkflow;
  console.log('turn:', attempts(sim), '| toasts:', sim.host.notices, '| badge unavailable:', badge?.unavailable, 'retryEligible:', badge?.retryEligible);
  assert.equal(sim.host.notices.length, 1);
  assert.equal(badge?.retryEligible, true);
  failRoute = false;
  requests.length = 0;
  const ok = await sim.controller.retryJudge();
  await sim.settle();
  console.log('retry ok:', ok, '| requests asked:', requests.map(r => r.ids.join(',')), '|', attempts(sim));
  const after = sim.host.chat().at(-1)!;
  console.log('swipes:', after.swipes.length, 'marker ruled:', Boolean(after.extra?.rpd?.r));
  assert.ok(!requests.some(r => r.ids.includes('move')), 'the successful move stage is replayed, not re-asked');
  assert.ok(after.extra?.rpd?.r, 'the retry swipe is ruled');
});

test('W2: a lore-only style failure (state stage) shows unavailable but no retry', async () => {
  const sim = await sim2({ configure: s => { s.controller.settings.modules.meters = true; } });
  flakyJudge(sim.controller, ids => ids.some(id => id.startsWith('meter_')));
  await sim.clickSend('I nod. "Open the gate, please."');
  const badge = sim.host.chat().at(-1)!.extra?.rpdWorkflow;
  console.log('turn:', attempts(sim), '| toasts:', sim.host.notices, '| badge unavailable:', badge?.unavailable, 'retryEligible:', badge?.retryEligible, 'marker', Boolean(lastMarker(sim)));
  assert.equal(badge?.unavailable, true);
  assert.equal(badge?.retryEligible, false);
});
