import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { EvaluationRequest, Json, Question } from '../../src/types.ts';
import {
  ProviderError,
  buildOpenRouterPayload,
  buildStructuredSchema,
  createOpenRouterTransport,
  createStructuredProvider,
  parseChatCompletionEnvelope,
} from '../../src/providers.ts';
import type { ChatCompletionSender, ProviderErrorCode } from '../../src/providers.ts';

// ---------------------------------------------------------------------------
// Fixtures and helpers (mirrors tests/unit/providers.test.ts)
// ---------------------------------------------------------------------------

type JevRequestFixture = { model: string; state: Json; questions: Record<string, Question> };

function loadJson<T>(relative: string): T {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as T;
}

const PRE_BATCH_REQUEST = loadJson<JevRequestFixture>('../fixtures/jev/pre-batch.request.json');

function makeRequest(state: Json, questions: Record<string, Question>, requestId = 'req-or-001'): EvaluationRequest {
  return {
    requestId,
    phase: 'guide',
    snapshot: {
      chatId: 'chat-1',
      cursorBefore: 'cursor-0',
      stateRevision: 1,
      scopeId: 'shared-public',
      profileRevision: 'p1',
      catalogRevision: 'c1',
      actorBindingRevision: 'a1',
      state,
    },
    questions,
  };
}

function preBatchRequest(): EvaluationRequest {
  return makeRequest(PRE_BATCH_REQUEST.state, PRE_BATCH_REQUEST.questions);
}

function answerOf(result: { answers: Record<string, unknown> }, id: string): unknown {
  const answer = result.answers[id];
  assert.ok(answer, `expected an answer for ${id}`);
  return answer;
}

async function rejectsWith(p: Promise<unknown>, code: ProviderErrorCode): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof ProviderError, `expected ProviderError, got ${String(e)}`);
    assert.equal(e.code, code, `expected code ${code}, got ${e.code}: ${e.message}`);
    return e;
  }
  assert.fail(`expected a rejection with code ${code}`);
}

// ---------------------------------------------------------------------------
// buildOpenRouterPayload
// ---------------------------------------------------------------------------

test('buildOpenRouterPayload: exact shape for a two-question request, no schema/key leakage', () => {
  const request = preBatchRequest();
  const schema = buildStructuredSchema(request.questions);
  const messages = [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: 'usr' },
  ];
  const payload = buildOpenRouterPayload({ model: 'qwen/qwen3.8-27b:free', messages, json_schema: schema });

  assert.deepEqual(payload, {
    stream: false,
    chat_completion_source: 'openrouter',
    model: 'qwen/qwen3.8-27b:free',
    messages,
    max_tokens: 2048,
    temperature: 0,
    include_reasoning: false,
    json_schema: { name: 'director_batch', description: 'RP Director decision batch', value: schema.schema, strict: true },
  });
  assert.deepEqual((payload.json_schema as { value: Json }).value, schema.schema);
  assert.equal(Object.hasOwn(payload.json_schema as object, 'schema'), false);
  assert.equal(Object.hasOwn(payload, 'schema'), false);
  assert.equal(Object.hasOwn(payload, 'api_key'), false);
  assert.equal(Object.hasOwn(payload, 'secret_id'), false);
  assert.equal(Object.hasOwn(payload, 'key'), false);
  assert.equal(payload.stream, false);
  assert.equal(payload.chat_completion_source, 'openrouter');
});

// ---------------------------------------------------------------------------
// Full provider round trip
// ---------------------------------------------------------------------------

test('createOpenRouterTransport round trip: speaker + gain_noul resolve with model_reported provenance and reported tokens', async () => {
  const send: ChatCompletionSender = async () => ({
    id: 'gen-1',
    model: 'qwen/qwen3.8-27b:free',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"speaker":"oren","gain_noul":0.35}' } }],
    usage: { prompt_tokens: 120, completion_tokens: 12 },
  });
  const provider = createStructuredProvider({ transport: createOpenRouterTransport(send), model: 'qwen/qwen3.8-27b:free' });
  const result = await provider.evaluate(preBatchRequest(), new AbortController().signal);

  assert.equal(result.provider, 'structured');
  assert.equal(result.requestedModel, 'qwen/qwen3.8-27b:free');
  assert.equal(result.returnedModel, 'qwen/qwen3.8-27b:free');
  assert.equal(result.inputTokens, 120);
  assert.equal(result.outputTokens, 12);
  assert.deepEqual(result.unresolvedQuestionIds, []);
  assert.deepEqual(answerOf(result, 'speaker'), {
    type: 'choice', choice: 'oren', probabilities: null, confidence: null, provenance: 'model_reported',
  });
  assert.deepEqual(answerOf(result, 'gain_noul'), { type: 'noul', noul: 0.35, confidence: null, provenance: 'model_reported' });
});

// ---------------------------------------------------------------------------
// parseChatCompletionEnvelope: pure envelope parsing
// ---------------------------------------------------------------------------

test('parseChatCompletionEnvelope: finish_reason "length" is truncated', () => {
  assert.throws(
    () => parseChatCompletionEnvelope({ choices: [{ finish_reason: 'length', message: { content: '{"speaker":"or' } }] }),
    (e: unknown) => e instanceof ProviderError && e.code === 'truncated',
  );
});

test('parseChatCompletionEnvelope: a non-empty message.refusal is a refusal', () => {
  assert.throws(
    () => parseChatCompletionEnvelope({ choices: [{ finish_reason: 'stop', message: { content: null, refusal: "I can't help with that" } }] }),
    (e: unknown) => e instanceof ProviderError && e.code === 'refusal',
  );
});

test('parseChatCompletionEnvelope: an { error } body is http, with the numeric code as status', () => {
  try {
    parseChatCompletionEnvelope({ error: { message: 'No endpoints found that support response_format', code: 404 } });
    assert.fail('expected a throw');
  } catch (e) {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.code, 'http');
    assert.equal(e.status, 404);
    assert.match(e.message, /No endpoints found/);
  }
});

test('parseChatCompletionEnvelope: an error body with a non-numeric code has status null', () => {
  try {
    parseChatCompletionEnvelope({ error: { message: 'rate limited', code: 'rate_limit_exceeded' } });
    assert.fail('expected a throw');
  } catch (e) {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.code, 'http');
    assert.equal(e.status, null);
  }
});

test('parseChatCompletionEnvelope: empty choices is malformed', () => {
  assert.throws(
    () => parseChatCompletionEnvelope({ choices: [] }),
    (e: unknown) => e instanceof ProviderError && e.code === 'malformed',
  );
});

test('parseChatCompletionEnvelope: null content is malformed', () => {
  assert.throws(
    () => parseChatCompletionEnvelope({ choices: [{ finish_reason: 'stop', message: { content: null } }] }),
    (e: unknown) => e instanceof ProviderError && e.code === 'malformed',
  );
});

test('parseChatCompletionEnvelope: a body that is not a plain object is malformed', () => {
  assert.throws(
    () => parseChatCompletionEnvelope(null),
    (e: unknown) => e instanceof ProviderError && e.code === 'malformed',
  );
  assert.throws(
    () => parseChatCompletionEnvelope('not an object'),
    (e: unknown) => e instanceof ProviderError && e.code === 'malformed',
  );
});

test('parseChatCompletionEnvelope: content given as text parts is joined before parsing', () => {
  const result = parseChatCompletionEnvelope({
    model: 'm',
    choices: [{
      finish_reason: 'stop',
      message: { content: [{ type: 'text', text: '{"speaker":"oren"' }, { type: 'text', text: ',"gain_noul":0.5}' }] },
    }],
  });
  assert.equal(result.content, '{"speaker":"oren","gain_noul":0.5}');
  assert.deepEqual(JSON.parse(result.content as string), { speaker: 'oren', gain_noul: 0.5 });
  assert.equal(result.usage, null);
});

// ---------------------------------------------------------------------------
// createOpenRouterTransport: model guard, error wrapping, abort, per-question failure
// ---------------------------------------------------------------------------

test('createOpenRouterTransport: send rejecting with a plain Error becomes ProviderError http', async () => {
  const send: ChatCompletionSender = async () => {
    throw new Error('Response not OK');
  };
  const provider = createStructuredProvider({ transport: createOpenRouterTransport(send), model: 'qwen/qwen3.8-27b:free' });
  const error = await rejectsWith(provider.evaluate(preBatchRequest(), new AbortController().signal), 'http');
  assert.match(error.message, /Response not OK/);
});

test('createOpenRouterTransport: empty, whitespace-only, or null model is unsupported and send is never called', async () => {
  let called = false;
  const send: ChatCompletionSender = async () => {
    called = true;
    return {};
  };
  const transport = createOpenRouterTransport(send);
  const schema = buildStructuredSchema(preBatchRequest().questions);
  for (const model of ['', '   ', null]) {
    await rejectsWith(transport({ model, messages: [], json_schema: schema }, new AbortController().signal), 'unsupported');
  }
  assert.equal(called, false);
});

test('createOpenRouterTransport: aborting the caller signal rejects with aborted, and send observes an aborted signal', async () => {
  let sawAbortedSignal = false;
  const send: ChatCompletionSender = (_payload, signal) =>
    new Promise((_resolve, reject) => {
      const fail = () => {
        sawAbortedSignal = signal.aborted;
        reject(new Error('send aborted'));
      };
      if (signal.aborted) { fail(); return; }
      signal.addEventListener('abort', fail, { once: true });
    });
  const provider = createStructuredProvider({ transport: createOpenRouterTransport(send), model: 'qwen/qwen3.8-27b:free' });
  const controller = new AbortController();
  const pending = provider.evaluate(preBatchRequest(), controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await rejectsWith(pending, 'aborted');
  assert.equal(sawAbortedSignal, true);
});

test('createOpenRouterTransport round trip: a boolean gain_noul leaves that question unresolved while speaker still resolves', async () => {
  const send: ChatCompletionSender = async () => ({
    model: 'm',
    choices: [{ finish_reason: 'stop', message: { content: '{"speaker":"oren","gain_noul":false}' } }],
  });
  const provider = createStructuredProvider({ transport: createOpenRouterTransport(send), model: 'm' });
  const result = await provider.evaluate(preBatchRequest(), new AbortController().signal);

  assert.deepEqual(result.unresolvedQuestionIds, ['gain_noul']);
  assert.equal(typeof result.errors.gain_noul, 'string');
  assert.ok((result.errors.gain_noul ?? '').length > 0);
  assert.deepEqual(Object.keys(result.answers), ['speaker']);
  const speaker = answerOf(result, 'speaker') as { choice: string };
  assert.equal(speaker.choice, 'oren');
});
