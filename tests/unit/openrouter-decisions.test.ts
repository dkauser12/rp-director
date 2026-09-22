import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenRouterDecisionsProvider, ProviderError } from '../../src/providers.ts';
import type { EvaluationRequest } from '../../src/types.ts';

const request: EvaluationRequest = {
  requestId: 'req_1',
  phase: 'guide',
  snapshot: { chatId: 'chat', cursorBefore: 'c0', stateRevision: 0, scopeId: 'shared-public', profileRevision: 'p1', catalogRevision: '', actorBindingRevision: '', state: { scene: 'dummy' } },
  questions: { gate: { type: 'noul', instructions: 'Is the gate open?', criteria: { true: 'Open.', false: 'Closed.' } } },
};

test('OpenRouter Decisions provider sends the exact decision payload and normalizes native Jev answers', async () => {
  let captured: unknown;
  const provider = createOpenRouterDecisionsProvider({
    model: '~typesafe/jev-latest',
    transport: async payload => {
      captured = payload;
      return { model: 'typesafe/jev-1.13', answers: { gate: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 10, output_tokens: 2 } };
    },
  });
  const result = await provider.evaluate(request, new AbortController().signal);
  assert.deepEqual(captured, { requestId: 'req_1', model: '~typesafe/jev-latest', state: { scene: 'dummy' }, questions: request.questions });
  assert.equal(result.provider, 'jev');
  assert.equal(result.returnedModel, 'typesafe/jev-1.13');
  assert.equal(result.answers.gate?.type, 'noul');
  assert.equal(result.inputTokens, 10);
});

test('OpenRouter Decisions provider rejects malformed plugin responses without fabricating answers', async () => {
  const provider = createOpenRouterDecisionsProvider({ model: '~typesafe/jev-latest', transport: async () => ({ model: 'x' }) });
  await assert.rejects(() => provider.evaluate(request, new AbortController().signal), error => error instanceof ProviderError && error.code === 'malformed');
});
