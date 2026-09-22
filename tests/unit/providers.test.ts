import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { Answer, DecisionProvider, EvaluationRequest, EvaluationResult, Json, Question } from '../../src/types.ts';
import {
  BUILTIN_MOCK_SCENARIOS,
  BUILTIN_RULES,
  ProviderError,
  buildStructuredMessages,
  buildStructuredSchema,
  createDirectFetchTransport,
  createJevProvider,
  createMockProvider,
  createRulesProvider,
  createStructuredProvider,
  normalizeJevAnswers,
  parseStructuredContent,
} from '../../src/providers.ts';
import type { ProviderErrorCode, StructuredTransport } from '../../src/providers.ts';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

type JevRequestFixture = { model: string; state: Json; questions: Record<string, Question> };
type JevResponseFixture = { model?: string; answers: Record<string, unknown>; usage?: { input_tokens: number; output_tokens: number } };
type OpenAiRequestFixture = {
  model: string;
  stream: boolean;
  messages: { role: string; content: string }[];
  response_format: { type: string; json_schema: { name: string; strict: boolean; schema: Json } };
};
type NormalizedFixture = Omit<EvaluationResult, 'errors'>;

function loadJson<T>(relative: string): T {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as T;
}

function loadJevPair(name: string): { request: JevRequestFixture; response: JevResponseFixture } {
  return {
    request: loadJson<JevRequestFixture>(`../fixtures/jev/${name}.request.json`),
    response: loadJson<JevResponseFixture>(`../fixtures/jev/${name}.response.json`),
  };
}

const JEV_PAIRS = ['choice', 'score', 'noul', 'pre-batch', 'post-batch'] as const;
const PRE_BATCH = loadJevPair('pre-batch');
const OPENAI_REQUEST = loadJson<OpenAiRequestFixture>('../fixtures/openai-compatible/pre-batch.request.json');
const MODEL_CONTENT = loadJson<Record<string, unknown>>('../fixtures/openai-compatible/model-content.response.json');
const NORMALIZED = loadJson<NormalizedFixture>('../fixtures/openai-compatible/normalized.response.json');

const SECRET = 'sk-test-secret';

function makeRequest(state: Json, questions: Record<string, Question>, requestId = 'req-test-001'): EvaluationRequest {
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
  return makeRequest(PRE_BATCH.request.state, PRE_BATCH.request.questions);
}

function answerOf(result: { answers: Record<string, Answer> }, id: string): Answer {
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

type FetchCall = { url: string; init: RequestInit };

/** A fake fetch that returns a canned response and records each call. */
function cannedFetch(status: number, body: string, headers: Record<string, string> = {}): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(body, { status, headers });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** A fake fetch that never resolves until its signal aborts. */
function hangingFetch(): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = ((input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      calls.push({ url: String(input), init: init ?? {} });
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function throwingFetch(message: string): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    throw new TypeError(message);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Fail the test if anything touches the global fetch while `fn` runs. */
async function withNoNetwork<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    throw new Error('network access is not allowed in this test');
  }) as unknown as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
    assert.equal(called, false, 'global fetch must not be called');
  }
}

function jevProvider(overrides: Partial<Parameters<typeof createJevProvider>[0]> = {}): DecisionProvider {
  return createJevProvider({
    baseUrl: 'https://api.typesafe.ai/v1/systemone',
    model: PRE_BATCH.request.model,
    getApiKey: () => SECRET,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// normalizeJevAnswers: fixture pairs and M3-20 rejections
// ---------------------------------------------------------------------------

test('all five Jev fixture pairs normalize with zero unresolved and provenance native', () => {
  for (const name of JEV_PAIRS) {
    const { request, response } = loadJevPair(name);
    const batch = normalizeJevAnswers(request.questions, response.answers);
    assert.deepEqual(batch.unresolvedQuestionIds, [], `${name}: unresolved`);
    assert.deepEqual(batch.errors, {}, `${name}: errors`);
    assert.deepEqual(Object.keys(batch.answers).sort(), Object.keys(request.questions).sort(), `${name}: answer ids`);
    for (const answer of Object.values(batch.answers)) assert.equal(answer.provenance, 'native');
  }
});

test('Jev fixture values: choice oren, score 1 with legend 0..4, noul 0.35', () => {
  const choice = normalizeJevAnswers(loadJevPair('choice').request.questions, loadJevPair('choice').response.answers);
  assert.deepEqual(answerOf(choice, 'choice'), {
    type: 'choice',
    choice: 'oren',
    probabilities: { oren: 1, mira: 0, tessa: 0, YIELD: 0 },
    confidence: 1,
    provenance: 'native',
  });

  const score = normalizeJevAnswers(loadJevPair('score').request.questions, loadJevPair('score').response.answers);
  const scoreAnswer = answerOf(score, 'score');
  assert.equal(scoreAnswer.type, 'score');
  if (scoreAnswer.type === 'score') {
    assert.equal(scoreAnswer.score, 1);
    assert.deepEqual(Object.keys(scoreAnswer.legend), ['0', '1', '2', '3', '4']);
    assert.equal(scoreAnswer.confidence, 1);
  }

  const noul = normalizeJevAnswers(loadJevPair('noul').request.questions, loadJevPair('noul').response.answers);
  assert.deepEqual(answerOf(noul, 'noul'), { type: 'noul', noul: 0.35, confidence: null, provenance: 'native' });

  const pre = normalizeJevAnswers(PRE_BATCH.request.questions, PRE_BATCH.response.answers);
  assert.equal(answerOf(pre, 'speaker').type, 'choice');
  assert.deepEqual(answerOf(pre, 'gain_noul'), { type: 'noul', noul: 0.35, confidence: null, provenance: 'native' });

  const post = loadJevPair('post-batch');
  const postBatch = normalizeJevAnswers(post.request.questions, post.response.answers);
  const location = answerOf(postBatch, 'location_oren');
  assert.equal(location.type === 'choice' ? location.choice : null, 'KEEP');
  assert.deepEqual(answerOf(postBatch, 'new_scene'), { type: 'noul', noul: 0, confidence: null, provenance: 'native' });
});

test('M3-04: a Jev noul answer with a confidence field normalizes to confidence null', () => {
  const batch = normalizeJevAnswers(PRE_BATCH.request.questions, {
    ...PRE_BATCH.response.answers,
    gain_noul: { type: 'noul', noul: 0.35, confidence: 0.8 },
  });
  assert.deepEqual(batch.unresolvedQuestionIds, []);
  assert.deepEqual(answerOf(batch, 'gain_noul'), { type: 'noul', noul: 0.35, confidence: null, provenance: 'native' });
});

test('M3-20: malformed, unknown-option, nonfinite, out-of-range and wrong-type answers are unresolved while valid siblings resolve', () => {
  const speaker = PRE_BATCH.request.questions.speaker;
  const gainNoul = PRE_BATCH.request.questions.gain_noul;
  assert.ok(speaker && gainNoul);
  const gainScore: Question = { type: 'score', instructions: 'rate', criteria: ['a', 'b', 'c', 'd', 'e'] };
  const questions: Record<string, Question> = {
    unknown_option: speaker,
    nan_noul: gainNoul,
    string_noul: gainNoul,
    out_of_range_score: gainScore,
    wrong_type: gainNoul,
    bad_prob_keys: speaker,
    bad_prob_sum: speaker,
    not_an_object: speaker,
    missing: gainNoul,
    valid_speaker: speaker,
    valid_noul: gainNoul,
    valid_score: gainScore,
  };
  const batch = normalizeJevAnswers(questions, {
    unknown_option: { type: 'choice', choice: 'bob' },
    nan_noul: { type: 'noul', noul: Number.NaN },
    string_noul: { type: 'noul', noul: 'abc' },
    out_of_range_score: { type: 'score', score: 7 },
    wrong_type: { type: 'score', score: 1 },
    bad_prob_keys: { type: 'choice', choice: 'oren', probabilities: { oren: 1, bob: 0 } },
    bad_prob_sum: { type: 'choice', choice: 'oren', probabilities: { oren: 0.7, mira: 0.7, tessa: 0, YIELD: 0 } },
    not_an_object: 42,
    valid_speaker: PRE_BATCH.response.answers.speaker,
    valid_noul: PRE_BATCH.response.answers.gain_noul,
    valid_score: { type: 'score', score: 1, probabilities: { '0': 0, '1': 1, '2': 0, '3': 0, '4': 0 }, confidence: 1 },
    ignored_extra_id: { type: 'noul', noul: 0.1 },
  });

  const expectedUnresolved = [
    'unknown_option',
    'nan_noul',
    'string_noul',
    'out_of_range_score',
    'wrong_type',
    'bad_prob_keys',
    'bad_prob_sum',
    'not_an_object',
    'missing',
  ];
  assert.deepEqual([...batch.unresolvedQuestionIds].sort(), [...expectedUnresolved].sort());
  for (const id of expectedUnresolved) {
    assert.equal(typeof batch.errors[id], 'string', `${id} has an error message`);
    assert.ok((batch.errors[id] ?? '').length > 0, `${id} error message is not empty`);
    assert.equal(batch.answers[id], undefined, `${id} must not be an answer`);
  }
  assert.match(batch.errors.unknown_option ?? '', /"bob"/);
  assert.match(batch.errors.wrong_type ?? '', /does not match/);
  assert.match(batch.errors.missing ?? '', /no answer/);
  assert.deepEqual(Object.keys(batch.answers).sort(), ['valid_noul', 'valid_score', 'valid_speaker']);
  assert.equal(batch.answers.ignored_extra_id, undefined);
});

// ---------------------------------------------------------------------------
// Jev provider transport
// ---------------------------------------------------------------------------

test('jev: request body is exactly { model, state, questions } and matches the pre-batch fixture', async () => {
  const { fetchImpl, calls } = cannedFetch(200, JSON.stringify(PRE_BATCH.response));
  const provider = jevProvider({ fetchImpl });
  const request = preBatchRequest();
  deepFreeze(request);

  const result = await provider.evaluate(request, new AbortController().signal);

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(call.init.method, 'POST');
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers.authorization, `Bearer ${SECRET}`);
  const sent = JSON.parse(String(call.init.body)) as unknown;
  assert.deepEqual(sent, PRE_BATCH.request);
  assert.deepEqual(Object.keys(sent as object).sort(), ['model', 'questions', 'state']);

  assert.equal(result.provider, 'jev');
  assert.equal(result.requestId, request.requestId);
  assert.equal(result.requestedModel, 'jev-latest');
  assert.equal(result.returnedModel, 'jev-latest');
  assert.equal(result.inputTokens, 0);
  assert.equal(result.outputTokens, 0);
  assert.equal(result.transportAttempts, 1);
  assert.ok(result.durationMs >= 0);
  assert.deepEqual(result.unresolvedQuestionIds, []);
  assert.deepEqual(answerOf(result, 'gain_noul'), { type: 'noul', noul: 0.35, confidence: null, provenance: 'native' });
});

test('jev: no API key throws no_credential before any fetch', async () => {
  const { fetchImpl, calls } = cannedFetch(200, JSON.stringify(PRE_BATCH.response));
  const provider = jevProvider({ fetchImpl, getApiKey: () => null });
  await rejectsWith(provider.evaluate(preBatchRequest(), new AbortController().signal), 'no_credential');
  const empty = jevProvider({ fetchImpl, getApiKey: () => '' });
  await rejectsWith(empty.evaluate(preBatchRequest(), new AbortController().signal), 'no_credential');
  assert.equal(calls.length, 0);
});

test('jev: HTTP error becomes ProviderError http with the status', async () => {
  const { fetchImpl } = cannedFetch(500, '{"error":"upstream exploded"}');
  const error = await rejectsWith(jevProvider({ fetchImpl }).evaluate(preBatchRequest(), new AbortController().signal), 'http');
  assert.equal(error.status, 500);
  assert.match(error.message, /500/);
});

test('jev: non-JSON body becomes ProviderError malformed', async () => {
  const { fetchImpl } = cannedFetch(200, 'not json');
  await rejectsWith(jevProvider({ fetchImpl }).evaluate(preBatchRequest(), new AbortController().signal), 'malformed');
});

test('jev: a body without an answers object is malformed, not silently unresolved', async () => {
  const { fetchImpl } = cannedFetch(200, '{"model":"jev-latest"}');
  await rejectsWith(jevProvider({ fetchImpl }).evaluate(preBatchRequest(), new AbortController().signal), 'malformed');
});

test('jev: body larger than maxResponseBytes becomes ProviderError too_large before parsing', async () => {
  const big = JSON.stringify({ ...PRE_BATCH.response, padding: 'x'.repeat(5000) });
  const { fetchImpl } = cannedFetch(200, big);
  await rejectsWith(jevProvider({ fetchImpl, maxResponseBytes: 1024 }).evaluate(preBatchRequest(), new AbortController().signal), 'too_large');

  const declared = cannedFetch(200, '{}', { 'content-length': '999999' });
  await rejectsWith(jevProvider({ fetchImpl: declared.fetchImpl, maxResponseBytes: 1024 }).evaluate(preBatchRequest(), new AbortController().signal), 'too_large');
});

test('jev: ids missing from answers are unresolved, extra ids are ignored', async () => {
  const { fetchImpl } = cannedFetch(200, JSON.stringify({ answers: { speaker: PRE_BATCH.response.answers.speaker, stray: 1 } }));
  const result = await jevProvider({ fetchImpl }).evaluate(preBatchRequest(), new AbortController().signal);
  assert.deepEqual(result.unresolvedQuestionIds, ['gain_noul']);
  assert.deepEqual(Object.keys(result.answers), ['speaker']);
  assert.equal(result.returnedModel, null);
  assert.equal(result.inputTokens, null);
  assert.equal(result.outputTokens, null);
});

test('jev: error messages never contain the API key', async () => {
  const echoing = cannedFetch(401, `{"error":"bad key ${SECRET}"}`);
  const http = await rejectsWith(jevProvider({ fetchImpl: echoing.fetchImpl }).evaluate(preBatchRequest(), new AbortController().signal), 'http');
  assert.equal(http.status, 401);
  assert.equal(http.message.includes(SECRET), false);

  const network = throwingFetch(`connect failed for Bearer ${SECRET}`);
  const netError = await rejectsWith(jevProvider({ fetchImpl: network.fetchImpl }).evaluate(preBatchRequest(), new AbortController().signal), 'network');
  assert.equal(netError.message.includes(SECRET), false);

  const garbage = cannedFetch(200, `garbage ${SECRET}`);
  const malformed = await rejectsWith(jevProvider({ fetchImpl: garbage.fetchImpl }).evaluate(preBatchRequest(), new AbortController().signal), 'malformed');
  assert.equal(malformed.message.includes(SECRET), false);
});

test('M1-03: aborting the caller signal rejects with aborted and the fetch saw an aborted signal', async () => {
  const { fetchImpl, calls } = hangingFetch();
  const controller = new AbortController();
  const pending = jevProvider({ fetchImpl }).evaluate(preBatchRequest(), controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await rejectsWith(pending, 'aborted');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.init.signal?.aborted, true);
});

test('M1-03: an already-aborted signal rejects with aborted without calling fetch', async () => {
  const { fetchImpl, calls } = hangingFetch();
  const controller = new AbortController();
  controller.abort();
  await rejectsWith(jevProvider({ fetchImpl }).evaluate(preBatchRequest(), controller.signal), 'aborted');
  assert.equal(calls.length, 0);
});

test('M1-03: the internal deadline rejects with timeout when fetch is slow', async () => {
  const { fetchImpl, calls } = hangingFetch();
  const started = Date.now();
  await rejectsWith(jevProvider({ fetchImpl, timeoutMs: 50 }).evaluate(preBatchRequest(), new AbortController().signal), 'timeout');
  assert.ok(Date.now() - started < 2000, 'timeout fired promptly');
  assert.equal(calls[0]?.init.signal?.aborted, true);
});

test('jev: capabilities and kind', () => {
  const provider = jevProvider();
  assert.equal(provider.kind, 'jev');
  assert.deepEqual(provider.capabilities, {
    primitives: ['choice', 'score', 'noul'],
    distributions: 'native',
    confidence: 'native_distribution_statistic',
    structuredOutput: 'native_typed',
    independentSharedStateBatch: true,
    maxQuestions: null,
    cancellation: 'abort_signal',
    usageReporting: true,
  });
});

// ---------------------------------------------------------------------------
// Structured provider
// ---------------------------------------------------------------------------

test('buildStructuredSchema matches the OpenAI-compatible fixture schema for speaker + gain_noul', () => {
  const built = buildStructuredSchema(PRE_BATCH.request.questions);
  assert.equal(built.name, 'director_batch');
  assert.equal(built.strict, true);
  assert.deepEqual(built.schema, OPENAI_REQUEST.response_format.json_schema.schema);
});

test('buildStructuredSchema encodes score as a bounded integer', () => {
  const built = buildStructuredSchema({
    gain_score: { type: 'score', instructions: 'rate', criteria: ['a', 'b', 'c', 'd', 'e'] },
  });
  assert.deepEqual(built.schema, {
    type: 'object',
    properties: { gain_score: { type: 'integer', minimum: 0, maximum: 4 } },
    required: ['gain_score'],
    additionalProperties: false,
  });
});

test('buildStructuredMessages uses the fixture system prompt and serializes only state + questions', () => {
  const messages = buildStructuredMessages(preBatchRequest());
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, 'system');
  assert.equal(messages[0]?.content, OPENAI_REQUEST.messages[0]?.content);
  assert.equal(messages[1]?.role, 'user');
  // The user message is the fixture's JSON (state + questions only) followed by an explicit answer-format section.
  const [jsonPart, ...rest] = String(messages[1]?.content ?? '').split('\n\n');
  const user = JSON.parse(jsonPart ?? '') as unknown;
  const fixtureUser = JSON.parse(OPENAI_REQUEST.messages[1]?.content ?? '') as unknown;
  assert.deepEqual(user, fixtureUser);
  assert.deepEqual(Object.keys(user as object).sort(), ['questions', 'state']);
  const format = rest.join('\n\n');
  assert.match(format, /Answer format/);
  assert.match(format, /"speaker": one of the option keys/);
  assert.match(format, /"gain_noul": a number from 0 to 1/);
  assert.match(format, /not a boolean/);
});

test('M2-13: structured bare values normalize to probabilities null, confidence null, provenance model_reported', () => {
  const batch = parseStructuredContent(PRE_BATCH.request.questions, MODEL_CONTENT);
  assert.deepEqual(batch.unresolvedQuestionIds, []);
  assert.deepEqual(batch.answers, NORMALIZED.answers);
  const speaker = answerOf(batch, 'speaker');
  assert.equal(speaker.type, 'choice');
  if (speaker.type === 'choice') {
    assert.equal(speaker.choice, 'oren');
    assert.equal(speaker.probabilities, null);
    assert.equal(speaker.confidence, null);
    assert.equal(speaker.provenance, 'model_reported');
  }
  const asString = parseStructuredContent(PRE_BATCH.request.questions, JSON.stringify(MODEL_CONTENT));
  assert.deepEqual(asString.answers, NORMALIZED.answers);
});

test('M2-13: structured provider result equals the normalized fixture (ignoring requestId/durationMs)', async () => {
  const transport: StructuredTransport = async () => ({ content: JSON.stringify(MODEL_CONTENT), model: null, usage: null });
  const provider = createStructuredProvider({ transport, model: null });
  const request = makeRequest(PRE_BATCH.request.state, PRE_BATCH.request.questions, NORMALIZED.requestId);
  const result = await provider.evaluate(request, new AbortController().signal);
  assert.deepEqual(result, { ...NORMALIZED, durationMs: result.durationMs, errors: {} });
});

test('structured: object values and unknown options are unresolved, not answers', () => {
  const batch = parseStructuredContent(PRE_BATCH.request.questions, { speaker: { choice: 'oren' }, gain_noul: 'high' });
  assert.deepEqual([...batch.unresolvedQuestionIds].sort(), ['gain_noul', 'speaker']);
  assert.deepEqual(batch.answers, {});
  assert.match(batch.errors.speaker ?? '', /bare value/);
});

test('M3-22: a structured refusal is a whole-request failure, never an answer', () => {
  assert.throws(
    () => parseStructuredContent(PRE_BATCH.request.questions, { refusal: "I can't" }),
    (e: unknown) => e instanceof ProviderError && e.code === 'refusal',
  );
  assert.throws(
    () => parseStructuredContent(PRE_BATCH.request.questions, JSON.stringify({ refusal: "I can't" })),
    (e: unknown) => e instanceof ProviderError && e.code === 'refusal',
  );
});

test('M3-22: truncated JSON content is malformed, never an answer', () => {
  assert.throws(
    () => parseStructuredContent(PRE_BATCH.request.questions, '{"speaker":"or'),
    (e: unknown) => e instanceof ProviderError && e.code === 'malformed',
  );
  assert.throws(
    () => parseStructuredContent(PRE_BATCH.request.questions, ['oren']),
    (e: unknown) => e instanceof ProviderError && e.code === 'malformed',
  );
  assert.throws(
    () => parseStructuredContent(PRE_BATCH.request.questions, null),
    (e: unknown) => e instanceof ProviderError && e.code === 'malformed',
  );
});

test('M3-22: direct transport maps finish_reason length to truncated and message.refusal to refusal', async () => {
  const truncated = cannedFetch(200, JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"speaker":"or' } }] }));
  const provider = createStructuredProvider({
    transport: createDirectFetchTransport({ baseUrl: 'http://127.0.0.1:1234/v1', getApiKey: () => null, fetchImpl: truncated.fetchImpl }),
    model: 'local-model',
  });
  await rejectsWith(provider.evaluate(preBatchRequest(), new AbortController().signal), 'truncated');

  const refused = cannedFetch(200, JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: null, refusal: "I can't help with that" } }] }));
  const refusing = createStructuredProvider({
    transport: createDirectFetchTransport({ baseUrl: 'http://127.0.0.1:1234/v1', getApiKey: () => null, fetchImpl: refused.fetchImpl }),
    model: 'local-model',
  });
  await rejectsWith(refusing.evaluate(preBatchRequest(), new AbortController().signal), 'refusal');
});

test('structured direct transport posts to /chat/completions with the json_schema response_format', async () => {
  const body = {
    model: 'local-model-v1',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(MODEL_CONTENT) } }],
    usage: { prompt_tokens: 120, completion_tokens: 12 },
  };
  const { fetchImpl, calls } = cannedFetch(200, JSON.stringify(body));
  const transport = createDirectFetchTransport({ baseUrl: 'http://127.0.0.1:1234/v1/', getApiKey: () => SECRET, fetchImpl });
  const provider = createStructuredProvider({ transport, model: 'local-model' });
  const request = preBatchRequest();
  deepFreeze(request);

  const result = await provider.evaluate(request, new AbortController().signal);

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, 'http://127.0.0.1:1234/v1/chat/completions');
  assert.equal(call.init.method, 'POST');
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${SECRET}`);
  const sent = JSON.parse(String(call.init.body)) as OpenAiRequestFixture;
  assert.equal(sent.model, 'local-model');
  assert.equal(sent.stream, false);
  assert.equal(sent.response_format.type, 'json_schema');
  assert.deepEqual(sent.response_format.json_schema, buildStructuredSchema(request.questions));
  assert.deepEqual(sent.response_format.json_schema.schema, OPENAI_REQUEST.response_format.json_schema.schema);
  assert.deepEqual(sent.messages, buildStructuredMessages(request));

  assert.equal(result.provider, 'structured');
  assert.equal(result.requestedModel, 'local-model');
  assert.equal(result.returnedModel, 'local-model-v1');
  assert.equal(result.inputTokens, 120);
  assert.equal(result.outputTokens, 12);
  assert.equal(result.transportAttempts, 1);
  assert.deepEqual(result.unresolvedQuestionIds, []);
  assert.deepEqual(result.answers, NORMALIZED.answers);
});

test('structured direct transport: bare number and string values parse', async () => {
  const content = JSON.stringify({ speaker: 'YIELD', gain_noul: 0.05, gain_score: 3 });
  const { fetchImpl } = cannedFetch(200, JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
  const transport = createDirectFetchTransport({ baseUrl: 'http://127.0.0.1:1234/v1', getApiKey: () => null, fetchImpl });
  const provider = createStructuredProvider({ transport, model: 'm' });
  const questions: Record<string, Question> = {
    ...PRE_BATCH.request.questions,
    gain_score: { type: 'score', instructions: 'rate', criteria: ['a', 'b', 'c', 'd', 'e'] },
  };
  const result = await provider.evaluate(makeRequest(PRE_BATCH.request.state, questions), new AbortController().signal);
  assert.deepEqual(result.unresolvedQuestionIds, []);
  const speaker = answerOf(result, 'speaker');
  assert.equal(speaker.type === 'choice' ? speaker.choice : null, 'YIELD');
  assert.deepEqual(answerOf(result, 'gain_noul'), { type: 'noul', noul: 0.05, confidence: null, provenance: 'model_reported' });
  const score = answerOf(result, 'gain_score');
  assert.equal(score.type === 'score' ? score.score : null, 3);
  assert.equal(result.returnedModel, null);
  assert.equal(result.inputTokens, null);
});

test('structured direct transport: no key is allowed, but 401/403 becomes http with a credentials message', async () => {
  const { fetchImpl, calls } = cannedFetch(401, `{"error":"unauthorized ${SECRET}"}`);
  const transport = createDirectFetchTransport({ baseUrl: 'http://127.0.0.1:1234/v1', getApiKey: () => null, fetchImpl });
  const provider = createStructuredProvider({ transport, model: 'm' });
  const error = await rejectsWith(provider.evaluate(preBatchRequest(), new AbortController().signal), 'http');
  assert.equal(error.status, 401);
  assert.match(error.message, /credentials/i);
  assert.equal(error.message.includes(SECRET), false);
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers.authorization, undefined);

  const withKey = cannedFetch(403, `forbidden ${SECRET}`);
  const keyed = createStructuredProvider({
    transport: createDirectFetchTransport({ baseUrl: 'http://127.0.0.1:1234/v1', getApiKey: () => SECRET, fetchImpl: withKey.fetchImpl }),
    model: 'm',
  });
  const forbidden = await rejectsWith(keyed.evaluate(preBatchRequest(), new AbortController().signal), 'http');
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.message.includes(SECRET), false);
});

test('structured direct transport: non-JSON body and missing choices are malformed; oversized body is too_large', async () => {
  const notJson = cannedFetch(200, 'not json at all');
  await rejectsWith(
    createStructuredProvider({
      transport: createDirectFetchTransport({ baseUrl: 'http://127.0.0.1:1234/v1', getApiKey: () => null, fetchImpl: notJson.fetchImpl }),
      model: 'm',
    }).evaluate(preBatchRequest(), new AbortController().signal),
    'malformed',
  );
  const noChoices = cannedFetch(200, '{"id":"x"}');
  await rejectsWith(
    createStructuredProvider({
      transport: createDirectFetchTransport({ baseUrl: 'http://127.0.0.1:1234/v1', getApiKey: () => null, fetchImpl: noChoices.fetchImpl }),
      model: 'm',
    }).evaluate(preBatchRequest(), new AbortController().signal),
    'malformed',
  );
  const huge = cannedFetch(200, JSON.stringify({ choices: [{ message: { content: 'x'.repeat(4000) } }] }));
  await rejectsWith(
    createStructuredProvider({
      transport: createDirectFetchTransport({ baseUrl: 'http://127.0.0.1:1234/v1', getApiKey: () => null, fetchImpl: huge.fetchImpl, maxResponseBytes: 512 }),
      model: 'm',
    }).evaluate(preBatchRequest(), new AbortController().signal),
    'too_large',
  );
});

test('structured provider: caller abort and internal deadline map to aborted / timeout', async () => {
  const hanging: StructuredTransport = (_payload, signal) =>
    new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });

  const controller = new AbortController();
  const pending = createStructuredProvider({ transport: hanging, model: 'm' }).evaluate(preBatchRequest(), controller.signal);
  controller.abort();
  await rejectsWith(pending, 'aborted');

  await rejectsWith(createStructuredProvider({ transport: hanging, model: 'm', timeoutMs: 40 }).evaluate(preBatchRequest(), new AbortController().signal), 'timeout');
});

test('structured provider: a transport error that is not a ProviderError becomes network', async () => {
  const failing: StructuredTransport = async () => {
    throw new Error('socket hang up');
  };
  const error = await rejectsWith(createStructuredProvider({ transport: failing, model: 'm' }).evaluate(preBatchRequest(), new AbortController().signal), 'network');
  assert.match(error.message, /socket hang up/);
});

test('structured: capabilities and kind', () => {
  const provider = createStructuredProvider({ transport: async () => ({ content: {}, model: null, usage: null }), model: null });
  assert.equal(provider.kind, 'structured');
  assert.deepEqual(provider.capabilities, {
    primitives: ['choice', 'score', 'noul'],
    distributions: 'unavailable',
    confidence: 'unavailable',
    structuredOutput: 'json_schema',
    independentSharedStateBatch: true,
    maxQuestions: null,
    cancellation: 'abort_signal',
    usageReporting: true,
  });
});

// ---------------------------------------------------------------------------
// Rules provider
// ---------------------------------------------------------------------------

test('rules: explicit_speaker returns a one-hot choice with confidence null when the id is eligible', async () => {
  await withNoNetwork(async () => {
    const provider = createRulesProvider({ routing: { speaker: 'explicit_speaker' } });
    const state: Json = { explicitSpeakerId: 'mira' };
    const request = makeRequest(state, { speaker: PRE_BATCH.request.questions.speaker as Question });
    deepFreeze(request);
    const result = await provider.evaluate(request, new AbortController().signal);
    assert.deepEqual(result.unresolvedQuestionIds, []);
    assert.deepEqual(answerOf(result, 'speaker'), {
      type: 'choice',
      choice: 'mira',
      probabilities: { oren: 0, mira: 1, tessa: 0, YIELD: 0 },
      confidence: null,
      provenance: 'rule',
    });
    assert.equal(result.provider, 'rules');
    assert.equal(result.requestedModel, null);
    assert.equal(result.returnedModel, null);
    assert.equal(result.inputTokens, null);
    assert.equal(result.outputTokens, null);
  });
});

test('rules: explicit_speaker is unresolved when the id is not eligible or absent', async () => {
  await withNoNetwork(async () => {
    const provider = createRulesProvider({ routing: { speaker: 'explicit_speaker' } });
    const speaker = PRE_BATCH.request.questions.speaker as Question;
    const ineligible = await provider.evaluate(makeRequest({ explicitSpeakerId: 'bob' }, { speaker }), new AbortController().signal);
    assert.deepEqual(ineligible.unresolvedQuestionIds, ['speaker']);
    assert.deepEqual(ineligible.answers, {});
    assert.match(ineligible.errors.speaker ?? '', /did not apply/);

    const absent = await provider.evaluate(makeRequest({ facts: {} }, { speaker }), new AbortController().signal);
    assert.deepEqual(absent.unresolvedQuestionIds, ['speaker']);

    const notObject = await provider.evaluate(makeRequest('oren', { speaker }), new AbortController().signal);
    assert.deepEqual(notObject.unresolvedQuestionIds, ['speaker']);
  });
});

test('rules: established_fact known-true -> noul 1, known-false -> noul 0, unknown -> unresolved', async () => {
  await withNoNetwork(async () => {
    const provider = createRulesProvider({ routing: { gain_noul: 'established_fact' } });
    const gainNoul = PRE_BATCH.request.questions.gain_noul as Question;

    const known = await provider.evaluate(
      makeRequest({ rule: { factId: 'permitPresented', expected: true }, facts: { permitPresented: true } }, { gain_noul: gainNoul }),
      new AbortController().signal,
    );
    assert.deepEqual(answerOf(known, 'gain_noul'), { type: 'noul', noul: 1, confidence: null, provenance: 'rule' });

    const differs = await provider.evaluate(
      makeRequest({ rule: { factId: 'permitPresented', expected: true }, facts: { permitPresented: false } }, { gain_noul: gainNoul }),
      new AbortController().signal,
    );
    assert.deepEqual(answerOf(differs, 'gain_noul'), { type: 'noul', noul: 0, confidence: null, provenance: 'rule' });

    const unknown = await provider.evaluate(
      makeRequest({ rule: { factId: 'permitPresented', expected: true }, facts: {} }, { gain_noul: gainNoul }),
      new AbortController().signal,
    );
    assert.deepEqual(unknown.unresolvedQuestionIds, ['gain_noul']);
    assert.deepEqual(unknown.answers, {});

    const noRule = await provider.evaluate(makeRequest({ facts: { permitPresented: true } }, { gain_noul: gainNoul }), new AbortController().signal);
    assert.deepEqual(noRule.unresolvedQuestionIds, ['gain_noul']);
  });
});

test('rules: unknown op name, missing routing, and rule output are validated per question', async () => {
  await withNoNetwork(async () => {
    const provider = createRulesProvider({
      registry: { ...BUILTIN_RULES, bad_output: () => ({ type: 'choice', choice: 'bob' }), thrower: () => { throw new Error('kaboom'); } },
      routing: { speaker: 'no_such_op', bad: 'bad_output', boom: 'thrower' },
    });
    const speaker = PRE_BATCH.request.questions.speaker as Question;
    const result = await provider.evaluate(
      makeRequest({ explicitSpeakerId: 'oren' }, { speaker, bad: speaker, boom: speaker, unrouted: speaker }),
      new AbortController().signal,
    );
    assert.deepEqual([...result.unresolvedQuestionIds].sort(), ['bad', 'boom', 'speaker', 'unrouted']);
    assert.deepEqual(result.answers, {});
    assert.match(result.errors.speaker ?? '', /unknown rule operation/);
    assert.match(result.errors.bad ?? '', /"bob"/);
    assert.match(result.errors.boom ?? '', /kaboom/);
    assert.match(result.errors.unrouted ?? '', /no rule/);
  });
});

test('rules: an aborted signal rejects with aborted', async () => {
  const provider = createRulesProvider({ routing: { speaker: 'explicit_speaker' } });
  const controller = new AbortController();
  controller.abort();
  await rejectsWith(provider.evaluate(preBatchRequest(), controller.signal), 'aborted');
});

test('rules: capabilities and kind', () => {
  const provider = createRulesProvider({ routing: {} });
  assert.equal(provider.kind, 'rules');
  assert.deepEqual(provider.capabilities, {
    primitives: ['choice', 'score', 'noul'],
    distributions: 'deterministic',
    confidence: 'unavailable',
    structuredOutput: 'in_process',
    independentSharedStateBatch: true,
    maxQuestions: null,
    cancellation: 'abort_signal',
    usageReporting: false,
  });
});

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

const FAILING_SCENARIOS: Record<string, ProviderErrorCode> = { malformed: 'malformed', refusal: 'refusal', timeout: 'timeout' };

test('mock: every builtin scenario evaluates, failing scenarios throw their declared code', async () => {
  await withNoNetwork(async () => {
    for (const name of Object.keys(BUILTIN_MOCK_SCENARIOS)) {
      const provider = createMockProvider({ scenario: name, timeoutMs: 30 });
      assert.equal(provider.kind, 'mock');
      const expectedFailure = FAILING_SCENARIOS[name];
      if (expectedFailure) {
        await rejectsWith(provider.evaluate(preBatchRequest(), new AbortController().signal), expectedFailure);
        continue;
      }
      const result = await provider.evaluate(preBatchRequest(), new AbortController().signal);
      assert.equal(result.provider, 'mock');
      assert.equal(result.transportAttempts, 1);
      for (const answer of Object.values(result.answers)) assert.equal(answer.provenance, 'fixture', `${name} provenance`);
      for (const id of result.unresolvedQuestionIds) assert.equal(typeof result.errors[id], 'string', `${name}/${id} error`);
    }
  });
});

test('mock: gate-deferred replays the pre-batch fixture answers', async () => {
  const result = await createMockProvider({ scenario: 'gate-deferred' }).evaluate(preBatchRequest(), new AbortController().signal);
  assert.deepEqual(result.unresolvedQuestionIds, []);
  const expected = normalizeJevAnswers(PRE_BATCH.request.questions, PRE_BATCH.response.answers).answers;
  const withFixtureProvenance = Object.fromEntries(Object.entries(expected).map(([id, a]) => [id, { ...a, provenance: 'fixture' }]));
  assert.deepEqual(result.answers, withFixtureProvenance);
});

test('mock: ordinary scenarios adapt the canned speaker to real request actor ids', async () => {
  const request = makeRequest(PRE_BATCH.request.state, {
    speaker: { type: 'choice', instructions: 'choose next speaker from these real ids', criteria: { 'oren-9303fa': 'Oren', 'mira-7befd3': 'Mira', YIELD: 'Yield' } },
    gain_noul: PRE_BATCH.request.questions.gain_noul!,
  });
  const result = await createMockProvider({ scenario: 'gate-deferred' }).evaluate(request, new AbortController().signal);
  const speaker = answerOf(result, 'speaker');
  assert.equal(speaker.type, 'choice');
  if (speaker.type === 'choice') assert.deepEqual([speaker.choice, speaker.probabilities], ['oren-9303fa', { 'oren-9303fa': 1, 'mira-7befd3': 0, YIELD: 0 }]);
});

test('mock: gate-achieved, gate-progress, yield, score-low and tie carry the declared values', async () => {
  const gainScore: Question = { type: 'score', instructions: 'rate', criteria: ['a', 'b', 'c', 'd', 'e'] };
  const questions: Record<string, Question> = { ...PRE_BATCH.request.questions, gain_score: gainScore };
  const request = makeRequest(PRE_BATCH.request.state, questions);
  const run = (scenario: string): Promise<EvaluationResult> => createMockProvider({ scenario }).evaluate(request, new AbortController().signal);

  const achieved = await run('gate-achieved');
  assert.equal((answerOf(achieved, 'gain_noul') as { noul: number }).noul, 0.9);
  const progress = await run('gate-progress');
  assert.equal((answerOf(progress, 'gain_noul') as { noul: number }).noul, 0.6);

  const yielded = await run('yield');
  assert.deepEqual(answerOf(yielded, 'speaker'), {
    type: 'choice',
    choice: 'YIELD',
    probabilities: { oren: 0, mira: 0, tessa: 0, YIELD: 1 },
    confidence: 1,
    provenance: 'fixture',
  });

  const scoreLow = await run('score-low');
  const score = answerOf(scoreLow, 'gain_score');
  assert.equal(score.type, 'score');
  if (score.type === 'score') {
    assert.equal(score.score, 1);
    assert.deepEqual(score.probabilities, { '0': 0, '1': 1, '2': 0, '3': 0, '4': 0 });
    assert.equal(score.confidence, 1);
    assert.deepEqual(Object.keys(score.legend), ['0', '1', '2', '3', '4']);
  }

  const tie = await run('tie');
  assert.deepEqual(answerOf(tie, 'speaker'), {
    type: 'choice',
    choice: 'oren',
    probabilities: { oren: 0.5, mira: 0.5, tessa: 0, YIELD: 0 },
    confidence: 0.5,
    provenance: 'fixture',
  });
});

test('mock: no-distribution replays the structured baseline shapes with null distribution and confidence', async () => {
  const result = await createMockProvider({ scenario: 'no-distribution' }).evaluate(preBatchRequest(), new AbortController().signal);
  assert.deepEqual(result.unresolvedQuestionIds, []);
  assert.deepEqual(answerOf(result, 'speaker'), { type: 'choice', choice: 'oren', probabilities: null, confidence: null, provenance: 'fixture' });
  assert.deepEqual(answerOf(result, 'gain_noul'), { type: 'noul', noul: 0.35, confidence: null, provenance: 'fixture' });
});

test('mock: unknown-option yields speaker unresolved and gain_noul 0.35', async () => {
  const result = await createMockProvider({ scenario: 'unknown-option' }).evaluate(preBatchRequest(), new AbortController().signal);
  assert.deepEqual(result.unresolvedQuestionIds, ['speaker']);
  assert.match(result.errors.speaker ?? '', /"bob"/);
  assert.equal(result.answers.speaker, undefined);
  assert.deepEqual(answerOf(result, 'gain_noul'), { type: 'noul', noul: 0.35, confidence: null, provenance: 'fixture' });
});

test('mock: questions absent from the scenario are unresolved with "no fixture answer"', async () => {
  const questions: Record<string, Question> = {
    ...PRE_BATCH.request.questions,
    extra: { type: 'noul', instructions: 'unfixtured' },
  };
  const result = await createMockProvider({ scenario: 'gate-deferred' }).evaluate(makeRequest(PRE_BATCH.request.state, questions), new AbortController().signal);
  assert.deepEqual(result.unresolvedQuestionIds, ['extra']);
  assert.equal(result.errors.extra, 'no fixture answer');
});

test('mock: unknown scenario name rejects with unsupported', async () => {
  await rejectsWith(createMockProvider({ scenario: 'does-not-exist' }).evaluate(preBatchRequest(), new AbortController().signal), 'unsupported');
});

test('M1-03: mock timeout scenario is abortable by the internal deadline and leaves no live timer', async () => {
  const started = Date.now();
  await rejectsWith(createMockProvider({ scenario: 'timeout', timeoutMs: 30 }).evaluate(preBatchRequest(), new AbortController().signal), 'timeout');
  assert.ok(Date.now() - started < 2000, 'the 60s scenario delay was cut short by the deadline');
});

test('M1-03: mock timeout scenario is abortable by the caller signal', async () => {
  const controller = new AbortController();
  const pending = createMockProvider({ scenario: 'timeout' }).evaluate(preBatchRequest(), controller.signal);
  setTimeout(() => controller.abort(), 5);
  await rejectsWith(pending, 'aborted');
});

test('mock: custom scenarios, returnedModel and usage pass through', async () => {
  const provider = createMockProvider({
    scenario: 'custom',
    scenarios: {
      custom: { answers: { gain_noul: 0.5 }, delayMs: 1, returnedModel: 'fixture-model', usage: { input: 7, output: 3 } },
    },
  });
  const result = await provider.evaluate(makeRequest(null, { gain_noul: { type: 'noul', instructions: 'x' } }), new AbortController().signal);
  assert.equal(result.returnedModel, 'fixture-model');
  assert.equal(result.inputTokens, 7);
  assert.equal(result.outputTokens, 3);
  assert.deepEqual(answerOf(result, 'gain_noul'), { type: 'noul', noul: 0.5, confidence: null, provenance: 'fixture' });
});

test('mock: capabilities', () => {
  assert.deepEqual(createMockProvider({ scenario: 'gate-deferred' }).capabilities, {
    primitives: ['choice', 'score', 'noul'],
    distributions: 'native',
    confidence: 'native_distribution_statistic',
    structuredOutput: 'in_process',
    independentSharedStateBatch: true,
    maxQuestions: null,
    cancellation: 'abort_signal',
    usageReporting: true,
  });
});
