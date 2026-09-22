import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_OUTCOMES, cloneTable, removeOutcome } from '../../src/table.ts';
import type { PolicyTable } from '../../src/table.ts';
import { DEFAULT_BANDS } from '../../src/profiles.ts';
import { TABLE_TEST_BAND, TABLE_TEST_OUTCOME, TABLE_TEST_SIGNAL, buildTableTestRequest, evaluateTableTest, localOnly, pickProbe } from '../../src/tabletest.ts';
import type { Answer, EvaluationResult } from '../../src/types.ts';
import { Controller } from '../../src/controller.ts';
import { defaultSettings } from '../../src/host.ts';
import type { Host } from '../../src/host.ts';

const base = (): PolicyTable => cloneTable({ outcomes: DEFAULT_OUTCOMES, bands: DEFAULT_BANDS });

const result = (answers: Record<string, Answer>, errors: Record<string, string> = {}): EvaluationResult => ({
  requestId: 'r', provider: 'structured', requestedModel: 'test/model', returnedModel: 'test/model', answers,
  unresolvedQuestionIds: Object.keys(errors), errors, inputTokens: 120, outputTokens: 30, durationMs: 850, transportAttempts: 1,
});
const noul = (v: number): Answer => ({ type: 'noul', noul: v, confidence: null, provenance: 'model_reported' });
const choice = (c: string): Answer => ({ type: 'choice', choice: c, probabilities: null, confidence: null, provenance: 'model_reported' });

test('the test request sends the edited table and asks three independent questions in one batch', () => {
  const t = base();
  const req = buildTableTestRequest(t, 'gain_noul', 'req-1');
  assert.deepEqual(Object.keys(req.questions).sort(), [TABLE_TEST_BAND, TABLE_TEST_OUTCOME, TABLE_TEST_SIGNAL].sort());
  assert.equal(req.questions[TABLE_TEST_SIGNAL]!.type, 'noul');
  const outcomeQ = req.questions[TABLE_TEST_OUTCOME]!;
  assert.ok(outcomeQ.type === 'choice');
  assert.deepEqual(Object.keys(outcomeQ.criteria), ['deferred', 'progress_only', 'achieved'], 'the outcome names travel as option names');
  const bandQ = req.questions[TABLE_TEST_BAND]!;
  assert.ok(bandQ.type === 'choice');
  assert.deepEqual(Object.keys(bandQ.criteria), ['b0', 'b1', 'b2', 'b3']);
  const state = req.snapshot.state as { policyTable: { outcomes: { name: string }[]; bands: { id: string; thresholdOutcome: string }[] }; probe: { x: number; bandId: string } };
  assert.deepEqual(state.policyTable.outcomes.map(o => o.name), ['deferred', 'progress_only', 'achieved']);
  assert.equal(state.policyTable.bands.length, 4);
  const probe = pickProbe(t);
  assert.deepEqual(state.probe, { x: probe.x, bandId: probe.bandId });
  assert.deepEqual([probe.bandId, probe.x, probe.expectedOutcome], ['b2', 0.625, 'progress_only']);
  assert.equal(buildTableTestRequest(t, 'gain_score', 'r').questions[TABLE_TEST_SIGNAL]!.type, 'score');
  const oneBand: PolicyTable = { outcomes: t.outcomes, bands: [{ ...t.bands[0]!, upper: 1, upperInclusive: true }] };
  assert.equal(Object.hasOwn(buildTableTestRequest(oneBand, 'gain_noul', 'r').questions, TABLE_TEST_BAND), false, 'one band needs no option test');
});

test('pass: every answer is in the expected format and the signal resolves through the edited table', () => {
  const t = base();
  const req = buildTableTestRequest(t, 'gain_noul', 'r');
  const report = evaluateTableTest(t, 'threshold', req, result({ [TABLE_TEST_SIGNAL]: noul(0.12), [TABLE_TEST_OUTCOME]: choice('progress_only'), [TABLE_TEST_BAND]: choice('b2') }));
  assert.equal(report.status, 'pass');
  assert.match(report.lines.join('\n'), /Noul 0\.12 → x = 0\.1200 → band b0 → deferred/);
  assert.match(report.lines.join('\n'), /One judge call, 850 ms, model test\/model, tokens 120 in \/ 30 out/);
  assert.equal(report.lines.some(l => /^Note:/.test(l)), false);
  assert.equal(report.networkCalls, 1);
});

test('dice mode shows the roll used for the demonstration', () => {
  const t = base();
  const req = buildTableTestRequest(t, 'gain_noul', 'r');
  const report = evaluateTableTest(t, 'sample', req, result({ [TABLE_TEST_SIGNAL]: noul(0.9), [TABLE_TEST_OUTCOME]: choice('progress_only'), [TABLE_TEST_BAND]: choice('b2') }));
  assert.equal(report.status, 'pass');
  assert.match(report.lines.join('\n'), /band b3 → achieved with a sample roll of 0\.5/);
});

test('a valid but wrong reading of the table is noted without failing, because play never depends on it', () => {
  const t = base();
  const req = buildTableTestRequest(t, 'gain_noul', 'r');
  const report = evaluateTableTest(t, 'threshold', req, result({ [TABLE_TEST_SIGNAL]: noul(0.5), [TABLE_TEST_OUTCOME]: choice('achieved'), [TABLE_TEST_BAND]: choice('b0') }));
  assert.equal(report.status, 'pass');
  assert.equal(report.lines.filter(l => /^Note:/.test(l)).length, 2);
});

test('fail: a missing or off-format answer is never papered over', () => {
  const t = base();
  const req = buildTableTestRequest(t, 'gain_noul', 'r');
  const report = evaluateTableTest(t, 'threshold', req, result({ [TABLE_TEST_OUTCOME]: choice('achieved'), [TABLE_TEST_BAND]: choice('b2') }, { [TABLE_TEST_SIGNAL]: 'structured output must be a bare value for this question, got false' }));
  assert.equal(report.status, 'fail');
  assert.match(report.lines[0]!, /table_signal: structured output must be a bare value/);
  const wrongType = evaluateTableTest(t, 'threshold', req, result({ [TABLE_TEST_SIGNAL]: choice('deferred'), [TABLE_TEST_OUTCOME]: choice('achieved'), [TABLE_TEST_BAND]: choice('b2') }));
  assert.equal(wrongType.status, 'fail');
});

test('an invalid table is reported locally and nothing is sent', () => {
  const broken = removeOutcome(base(), 2);
  const report = evaluateTableTest(broken, 'threshold', buildTableTestRequest(base(), 'gain_noul', 'r'), result({}));
  assert.equal(report.status, 'fail');
  assert.equal(report.networkCalls, 0);
  assert.equal(localOnly('mock').status, 'local_only');
});

// Controller-level: the button's code path, with a fake host and a canned model behind the real structured provider.
function fakeHost(kind: 'mock' | 'openrouter', respond: (payload: { state: unknown }) => unknown, calls: { n: number }): Host {
  const settings = defaultSettings();
  settings.connection = { kind, baseUrl: '', model: '~typesafe/jev-latest', stProfileId: '', mockScenario: 'gate-deferred' };
  const transport = async (payload: { state: unknown }) => { calls.n += 1; return { answers: respond(payload), model: 'typesafe/jev-1.13', usage: { input_tokens: 10, output_tokens: 5 } }; };
  return { settings: () => settings, openRouterDecisionsTransport: () => transport, clearInjection: () => undefined, toast: () => undefined } as unknown as Host;
}

test('Controller.testTable: mock connection stays local; a model connection makes exactly one call and passes on clean answers', async () => {
  const none = { n: 0 };
  const local = await new Controller(fakeHost('mock', () => ({}), none)).testTable(base(), 'threshold');
  assert.equal(local.status, 'local_only');
  assert.equal(none.n, 0);

  const calls = { n: 0 };
  const answering = fakeHost('openrouter', (payload) => {
    const body = payload.state as { policyTable: { bands: { id: string; thresholdOutcome: string }[] }; probe: { bandId: string } };
    const band = body.policyTable.bands.find(b => b.id === body.probe.bandId)!;
    return { [TABLE_TEST_SIGNAL]: 0.8, [TABLE_TEST_OUTCOME]: band.thresholdOutcome, [TABLE_TEST_BAND]: band.id };
  }, calls);
  const pass = await new Controller(answering).testTable(base(), 'threshold');
  assert.equal(pass.status, 'pass');
  assert.equal(calls.n, 1);
  assert.match(pass.lines.join('\n'), /band b3 → achieved/);

  const badCalls = { n: 0 };
  const boolean = fakeHost('openrouter', () => ({ [TABLE_TEST_SIGNAL]: false, [TABLE_TEST_OUTCOME]: 'achieved', [TABLE_TEST_BAND]: 'b2' }), badCalls);
  const fail = await new Controller(boolean).testTable(base(), 'threshold');
  assert.equal(fail.status, 'fail');
  assert.equal(badCalls.n, 1);

  const invalidCalls = { n: 0 };
  const invalid = await new Controller(fakeHost('openrouter', () => ({}), invalidCalls)).testTable(removeOutcome(base(), 2), 'threshold');
  assert.equal(invalid.status, 'fail');
  assert.equal(invalidCalls.n, 0, 'an invalid table never reaches the model');
});
