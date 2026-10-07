import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionForwarder, DecisionProxyError, validateDecisionRequest } from '../core.mjs';

const request = () => ({
    requestId: 'req_1',
    model: '~typesafe/jev-latest',
    state: { description: 'Dummy.', record: 'The light is on.' },
    questions: {
        light: { type: 'choice', instructions: 'Classify the light.', criteria: { on: 'On.', off: 'Off.' } },
    },
});

test('valid request is reduced to the exact upstream decisions shape', () => {
    const result = validateDecisionRequest(request());
    assert.equal(result.requestId, 'req_1');
    assert.deepEqual(Object.keys(result.upstream), ['model', 'state', 'questions']);
});

test('non-Jev models, unknown fields, and malformed questions are rejected', () => {
    assert.throws(() => validateDecisionRequest({ ...request(), model: 'openai/gpt-5' }), error => error instanceof DecisionProxyError && error.code === 'invalid_model');
    assert.throws(() => validateDecisionRequest({ ...request(), messages: [] }), error => error instanceof DecisionProxyError && error.code === 'invalid_request');
    const malformed = request();
    malformed.questions.light = { type: 'choice', instructions: '', criteria: { on: 'On.' } };
    assert.throws(() => validateDecisionRequest(malformed), error => error instanceof DecisionProxyError && error.code === 'invalid_question');
});

test('forwarder never includes the API key in its body and preserves typed answers', async () => {
    let seen;
    const fetchImpl = async (_url, options) => {
        seen = options;
        return new Response(JSON.stringify({
            model: 'typesafe/jev-1.13', answers: { light: { type: 'choice', choice: 'on', probabilities: { on: 1, off: 0 }, confidence: 1 } },
            usage: { cost: 0.0012, input_tokens: 20, output_tokens: 4 }, provider: 'TypeSafe', id: 'dec_1',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const forward = createDecisionForwarder({ getApiKey: () => 'secret-value', fetchImpl });
    const result = await forward(request());
    assert.equal(result.status, 200);
    assert.equal(result.body.answers.light.choice, 'on');
    assert.deepEqual(result.body.usage, { cost: 0.0012, input_tokens: 20, output_tokens: 4 });
    assert.equal(JSON.stringify(result.body).includes('secret-value'), false);
    assert.equal(seen.headers.authorization, 'Bearer secret-value');
    assert.equal(JSON.parse(seen.body).requestId, undefined);
});

test('upstream errors are bounded and missing keys fail before fetch', async () => {
    let calls = 0;
    const noKey = createDecisionForwarder({ getApiKey: () => '', fetchImpl: async () => { calls++; } });
    await assert.rejects(() => noKey(request()), error => error instanceof DecisionProxyError && error.code === 'missing_openrouter_key');
    assert.equal(calls, 0);

    const upstream = createDecisionForwarder({
        getApiKey: () => 'x',
        fetchImpl: async () => new Response(JSON.stringify({ error: { code: 400, message: 'Bad decision request' } }), { status: 400 }),
    });
    const result = await upstream(request());
    assert.deepEqual(result.body.error, { code: '400', message: 'Bad decision request' });
});
