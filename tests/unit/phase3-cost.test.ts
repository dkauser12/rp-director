import { test } from 'node:test';
import assert from 'node:assert/strict';
// The companion server plugin intentionally remains dependency-free JavaScript.
// @ts-expect-error JavaScript server module has no declaration file.
import { createDecisionForwarder } from '../../server-plugin/core.mjs';
import { createOpenRouterDecisionsProvider } from '../../src/providers.ts';
import { activityUsage } from '../../src/activity.ts';
import { buildWorkflowBadge, isWorkflowBadge } from '../../src/workflow-badge.ts';
import { costLabel, failedRequestUsage, mergeRequestUsage, requestUsage, summarizeUsage, usageLabel } from '../../src/usage.ts';
import type { EvaluationRequest, GenerationAttempt, RequestUsage } from '../../src/types.ts';

const request: EvaluationRequest = { requestId: 'request', phase: 'guide',
  snapshot: { chatId: 'example-chat', cursorBefore: 'before', stateRevision: 0, scopeId: 'public', profileRevision: 'profile', catalogRevision: '', actorBindingRevision: '', state: {} },
  questions: { gate: { type: 'noul', instructions: 'Is the gate open?' } } };
const receipt = (requestId = 'request', costUsd: number | null = 0.0012): RequestUsage => ({ requestId, stage: 'ruling', costUsd, inputTokens: 20, outputTokens: 4, durationMs: 6 });

test('C4 server plugin preserves OpenRouter usage and the provider carries USD and tokens to a receipt', async () => {
  const upstreamUsage = { cost: 0.000019992, input_tokens: 476, output_tokens: 70 };
  let calls = 0;
  const forward = createDecisionForwarder({ getApiKey: () => 'example-test-key', fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify({ answers: { gate: { type: 'noul', noul: 0.8 } }, model: 'typesafe/jev-1.13', usage: upstreamUsage }), { status: 200 });
  } });
  const provider = createOpenRouterDecisionsProvider({ model: '~typesafe/jev-latest', transport: async payload => {
    const response = await forward(payload);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.usage, upstreamUsage);
    return response.body;
  } });
  const result = await provider.evaluate(request, new AbortController().signal);
  assert.equal(calls, 1);
  assert.equal(result.costUsd, upstreamUsage.cost);
  assert.equal(result.inputTokens, 476);
  assert.equal(result.outputTokens, 70);
  const recorded = requestUsage(result, 'ruling');
  assert.equal(recorded.costUsd, upstreamUsage.cost);
  assert.equal(recorded.stage, 'ruling');
  assert.match(costLabel(recorded.costUsd), /\$<0\.0001/, 'a small positive charge is not displayed as free');
});

test('C4 missing or invalid cost remains unknown while a reported zero remains zero', async () => {
  for (const [raw, expected] of [[undefined, null], [null, null], ['0.2', null], [-1, null], [Infinity, null], [0, 0]] as const) {
    const provider = createOpenRouterDecisionsProvider({ model: '~typesafe/jev-latest', transport: async () => ({ answers: { gate: { type: 'noul', noul: 0.8 } }, usage: { cost: raw } }) });
    const result = await provider.evaluate(request, new AbortController().signal);
    assert.equal(result.costUsd, expected);
  }
  assert.equal(costLabel(null), 'cost not reported');
  assert.equal(costLabel(0), '$0.0000');
  assert.equal(costLabel(0.0012, 2), '$0.0012 reported · 2 costs not reported');
});

test('C4 usage totals deduplicate reused requests and identify partially reported cost', () => {
  const first = receipt(), second = receipt('second', 0.002);
  const failed = failedRequestUsage('failed', 'reply_check', 12);
  const records = mergeRequestUsage([first, second], [first, failed]);
  assert.equal(records.length, 3);
  const totals = summarizeUsage(records);
  assert.ok(Math.abs(totals.costUsd! - 0.0032) < 1e-12);
  assert.deepEqual({ ...totals, costUsd: null }, { requests: 3, costUsd: null, inputTokens: 40, outputTokens: 8, durationMs: 24, unreportedCostRequests: 1 });
  assert.match(usageLabel(records), /Requests: 3 · \$0\.0032 reported · 1 cost not reported · Tokens in\/out: 40\/8/);
  assert.equal(summarizeUsage([]).costUsd, null);
  assert.equal(summarizeUsage([receipt('free', 0)]).costUsd, 0);
  records[0]!.costUsd = 7;
  assert.equal(first.costUsd, 0.0012, 'merged receipts own their copies');
});

test('C4 badge receipts survive inspector trimming and remain isolated from the attempt', () => {
  const attempt: GenerationAttempt = { attemptId: 'attempt', resolutionId: null, actorId: null, cursorBefore: 'before',
    status: 'accepted', generationType: 'normal', hostMessageRef: 1, hostVariantRef: 0, variantId: 'variant', injectedText: '', epoch: 1, unadjudicated: false, createdAt: 1,
    requestUsage: [receipt()] };
  const badge = buildWorkflowBadge({ attempt });
  assert.equal(isWorkflowBadge(badge), true);
  assert.deepEqual(activityUsage({ badge, entries: [] }), [receipt()]);
  attempt.requestUsage![0]!.costUsd = 3;
  assert.equal(badge.requestUsage![0]!.costUsd, 0.0012);
  for (const malformed of [{ ...receipt(), costUsd: -1 }, { ...receipt(), inputTokens: NaN }, { ...receipt(), durationMs: 'bad' }, null]) {
    assert.equal(isWorkflowBadge({ ...badge, requestUsage: [malformed] }), false);
  }
});
