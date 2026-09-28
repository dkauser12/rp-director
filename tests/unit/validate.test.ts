import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { Answer, Json, Question } from '../../src/types.ts';
import { isFiniteNumber, isUnitInterval, validateAnswer, validateProbabilities } from '../../src/validate.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type JevRequestFixture = { model: string; state: Json; questions: Record<string, Question> };
type JevResponseFixture = { model?: string; answers: Record<string, unknown>; usage?: unknown };

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

function question(fixture: JevRequestFixture, id: string): Question {
  const q = fixture.questions[id];
  assert.ok(q, `fixture has question ${id}`);
  return q;
}

function expectOk(question: Question, raw: unknown, provenance: 'native' | 'model_reported' | 'rule' | 'fixture' = 'native'): Answer {
  const result = validateAnswer(question, raw, provenance);
  assert.ok(result.ok, `expected a valid answer, got error: ${result.ok ? '' : result.error}`);
  return result.answer;
}

function expectError(question: Question, raw: unknown, pattern?: RegExp): string {
  const result = validateAnswer(question, raw, 'native');
  assert.ok(!result.ok, `expected a validation error, got answer ${JSON.stringify(result.ok ? result.answer : null)}`);
  if (pattern) assert.match(result.error, pattern);
  return result.error;
}

const SPEAKER: Question = {
  type: 'choice',
  instructions: 'who speaks',
  criteria: { oren: 'Oren', mira: 'Mira', tessa: 'Tessa', YIELD: 'yield' },
};
const GAIN_NOUL: Question = { type: 'noul', instructions: 'is the gain justified' };
const GAIN_SCORE: Question = {
  type: 'score',
  instructions: 'rate support',
  criteria: ['opposes', 'weak', 'mixed', 'strong', 'clear'],
};

// ---------------------------------------------------------------------------
// Primitive predicates
// ---------------------------------------------------------------------------

test('isFiniteNumber accepts finite numbers only', () => {
  assert.equal(isFiniteNumber(0), true);
  assert.equal(isFiniteNumber(-3.5), true);
  assert.equal(isFiniteNumber(Number.NaN), false);
  assert.equal(isFiniteNumber(Number.POSITIVE_INFINITY), false);
  assert.equal(isFiniteNumber('1'), false);
  assert.equal(isFiniteNumber(null), false);
  assert.equal(isFiniteNumber(undefined), false);
});

test('isUnitInterval accepts finite numbers in [0, 1] only', () => {
  assert.equal(isUnitInterval(0), true);
  assert.equal(isUnitInterval(1), true);
  assert.equal(isUnitInterval(0.35), true);
  assert.equal(isUnitInterval(-0.01), false);
  assert.equal(isUnitInterval(1.01), false);
  assert.equal(isUnitInterval(Number.NaN), false);
  assert.equal(isUnitInterval('0.5'), false);
});

// ---------------------------------------------------------------------------
// validateProbabilities
// ---------------------------------------------------------------------------

test('validateProbabilities accepts exactly the given keys in any order', () => {
  const result = validateProbabilities(['a', 'b', 'c'], { c: 0.25, a: 0.5, b: 0.25 });
  assert.ok(result.ok);
  assert.deepEqual(result.value, { a: 0.5, b: 0.25, c: 0.25 });
});

test('validateProbabilities tolerates rounding within 1e-6', () => {
  const result = validateProbabilities(['a', 'b', 'c'], { a: 0.3333333, b: 0.3333333, c: 0.3333334 });
  assert.ok(result.ok);
});

test('validateProbabilities rejects missing, extra, nonfinite, out-of-range and non-normalized values', () => {
  const missing = validateProbabilities(['a', 'b'], { a: 1 });
  assert.ok(!missing.ok);
  assert.match(missing.error, /missing "b"/);

  const extra = validateProbabilities(['a', 'b'], { a: 1, b: 0, z: 0 });
  assert.ok(!extra.ok);
  assert.match(extra.error, /unexpected "z"/);

  const nonfinite = validateProbabilities(['a', 'b'], { a: Number.NaN, b: 1 });
  assert.ok(!nonfinite.ok);
  assert.match(nonfinite.error, /"a"/);

  const negative = validateProbabilities(['a', 'b'], { a: -0.5, b: 1.5 });
  assert.ok(!negative.ok);

  const sum = validateProbabilities(['a', 'b'], { a: 0.5, b: 0.6 });
  assert.ok(!sum.ok);
  assert.match(sum.error, /sum to 1/);

  const notObject = validateProbabilities(['a'], [1]);
  assert.ok(!notObject.ok);
  const str = validateProbabilities(['a'], '1');
  assert.ok(!str.ok);
});

// ---------------------------------------------------------------------------
// Jev fixture pairs
// ---------------------------------------------------------------------------

test('every Jev fixture pair validates with provenance native', () => {
  for (const name of JEV_PAIRS) {
    const { request, response } = loadJevPair(name);
    for (const id of Object.keys(request.questions)) {
      const answer = expectOk(question(request, id), response.answers[id], 'native');
      assert.equal(answer.provenance, 'native', `${name}/${id} provenance`);
      assert.equal(answer.type, question(request, id).type, `${name}/${id} type`);
    }
  }
});

test('choice fixture normalizes to oren with a one-hot distribution and confidence 1', () => {
  const { request, response } = loadJevPair('choice');
  const answer = expectOk(question(request, 'choice'), response.answers.choice);
  assert.deepEqual(answer, {
    type: 'choice',
    choice: 'oren',
    probabilities: { oren: 1, mira: 0, tessa: 0, YIELD: 0 },
    confidence: 1,
    provenance: 'native',
  });
});

test('score fixture normalizes to score 1 with a legend keyed 0..4 from the criteria', () => {
  const { request, response } = loadJevPair('score');
  const q = question(request, 'score');
  const answer = expectOk(q, response.answers.score);
  assert.equal(answer.type, 'score');
  if (answer.type !== 'score') return;
  assert.equal(answer.score, 1);
  assert.deepEqual(Object.keys(answer.legend), ['0', '1', '2', '3', '4']);
  assert.equal(q.type, 'score');
  if (q.type !== 'score') return;
  assert.deepEqual(Object.values(answer.legend), q.criteria);
  assert.deepEqual(answer.probabilities, { '0': 0, '1': 1, '2': 0, '3': 0, '4': 0 });
  assert.equal(answer.confidence, 1);
});

test('noul fixture normalizes to 0.35 with confidence null', () => {
  const { request, response } = loadJevPair('noul');
  const answer = expectOk(question(request, 'noul'), response.answers.noul);
  assert.deepEqual(answer, { type: 'noul', noul: 0.35, confidence: null, provenance: 'native' });
});

// ---------------------------------------------------------------------------
// Noul confidence invariant
// ---------------------------------------------------------------------------

test('M3-04: a noul answer carrying a confidence field normalizes to confidence null', () => {
  const answer = expectOk(GAIN_NOUL, { type: 'noul', noul: 0.35, confidence: 0.9 });
  assert.equal(answer.confidence, null);
  // Never inferred from distance to 0.5 either.
  const near = expectOk(GAIN_NOUL, { type: 'noul', noul: 0.5 });
  assert.equal(near.confidence, null);
  const far = expectOk(GAIN_NOUL, { type: 'noul', noul: 0.99 });
  assert.equal(far.confidence, null);
});

// ---------------------------------------------------------------------------
// Choice rules
// ---------------------------------------------------------------------------

test('choice: unknown option is rejected with a readable message', () => {
  const error = expectError(SPEAKER, { type: 'choice', choice: 'bob' }, /"bob"/);
  assert.match(error, /oren, mira, tessa, YIELD/);
});

test('choice: probabilities must cover exactly the option keys and sum to 1', () => {
  expectError(SPEAKER, { type: 'choice', choice: 'oren', probabilities: { oren: 1, mira: 0 } }, /missing/);
  expectError(SPEAKER, { type: 'choice', choice: 'oren', probabilities: { oren: 1, mira: 0, tessa: 0, YIELD: 0, bob: 0 } }, /unexpected/);
  expectError(SPEAKER, { type: 'choice', choice: 'oren', probabilities: { oren: 0.9, mira: 0.9, tessa: 0, YIELD: 0 } }, /sum/);
});

test('choice: probabilities and confidence are optional and become null, never fabricated', () => {
  const answer = expectOk(SPEAKER, { type: 'choice', choice: 'mira' });
  assert.deepEqual(answer, { type: 'choice', choice: 'mira', probabilities: null, confidence: null, provenance: 'native' });
  const explicitNull = expectOk(SPEAKER, { type: 'choice', choice: 'mira', probabilities: null, confidence: null });
  assert.deepEqual(explicitNull, answer);
});

test('choice: confidence must be a unit interval when present', () => {
  expectError(SPEAKER, { type: 'choice', choice: 'oren', confidence: 1.5 }, /confidence/);
  expectError(SPEAKER, { type: 'choice', choice: 'oren', confidence: 'high' }, /confidence/);
  const answer = expectOk(SPEAKER, { type: 'choice', choice: 'oren', confidence: 0.5 });
  assert.equal(answer.confidence, 0.5);
});

test('choice: bare option string is the structured baseline shape', () => {
  const answer = expectOk(SPEAKER, 'oren', 'model_reported');
  assert.deepEqual(answer, { type: 'choice', choice: 'oren', probabilities: null, confidence: null, provenance: 'model_reported' });
  expectError(SPEAKER, 'bob', /"bob"/);
  expectError(SPEAKER, 1, /option key string/);
});

// ---------------------------------------------------------------------------
// Score rules
// ---------------------------------------------------------------------------

test('score: legend is always rebuilt from the criteria, whatever the raw answer carried', () => {
  const answer = expectOk(GAIN_SCORE, { type: 'score', score: 2, legend: { '0': 'wrong', '9': 'junk' } });
  assert.equal(answer.type, 'score');
  if (answer.type !== 'score') return;
  assert.deepEqual(answer.legend, { '0': 'opposes', '1': 'weak', '2': 'mixed', '3': 'strong', '4': 'clear' });
  assert.equal(answer.probabilities, null);
  assert.equal(answer.confidence, null);
});

test('score: fractional expectation is accepted when it matches the distribution', () => {
  const answer = expectOk(GAIN_SCORE, {
    type: 'score',
    score: 1.5,
    probabilities: { '0': 0, '1': 0.5, '2': 0.5, '3': 0, '4': 0 },
    confidence: 0.4,
  });
  assert.equal(answer.type, 'score');
  if (answer.type !== 'score') return;
  assert.equal(answer.score, 1.5);
  assert.equal(answer.confidence, 0.4);
});

test('score: expectation mismatch, wrong keys, and out-of-range values are rejected', () => {
  expectError(GAIN_SCORE, { type: 'score', score: 2, probabilities: { '0': 0, '1': 1, '2': 0, '3': 0, '4': 0 } }, /expectation/);
  expectError(GAIN_SCORE, { type: 'score', score: 1, probabilities: { a: 1 } }, /keys/);
  expectError(GAIN_SCORE, { type: 'score', score: 5 }, /range/);
  expectError(GAIN_SCORE, { type: 'score', score: -1 }, /range/);
  expectError(GAIN_SCORE, { type: 'score', score: Number.NaN }, /finite/);
  expectError(GAIN_SCORE, { type: 'score', score: '1' }, /finite/);
});

test('score: a question with fewer than 2 criteria cannot be answered', () => {
  const bad: Question = { type: 'score', instructions: 'x', criteria: ['only'] };
  expectError(bad, { type: 'score', score: 0 }, /at least 2/);
});

test('score: bare number is the structured baseline shape', () => {
  const answer = expectOk(GAIN_SCORE, 3, 'model_reported');
  assert.equal(answer.type, 'score');
  if (answer.type !== 'score') return;
  assert.equal(answer.score, 3);
  assert.equal(answer.probabilities, null);
  assert.equal(answer.confidence, null);
  assert.equal(answer.provenance, 'model_reported');
});

// ---------------------------------------------------------------------------
// Noul rules and wrong types
// ---------------------------------------------------------------------------

test('noul: nonfinite or non-numeric values are rejected', () => {
  expectError(GAIN_NOUL, { type: 'noul', noul: Number.NaN }, /noul/);
  expectError(GAIN_NOUL, { type: 'noul', noul: 'abc' }, /noul/);
  expectError(GAIN_NOUL, { type: 'noul', noul: 1.2 }, /noul/);
  expectError(GAIN_NOUL, { type: 'noul' }, /noul/);
  expectError(GAIN_NOUL, 'abc', /number/);
  expectError(GAIN_NOUL, Number.POSITIVE_INFINITY, /noul/);
});

test('noul: bare number is the structured baseline shape', () => {
  const answer = expectOk(GAIN_NOUL, 0.35, 'model_reported');
  assert.deepEqual(answer, { type: 'noul', noul: 0.35, confidence: null, provenance: 'model_reported' });
});

test('wrong type: a raw type that does not match the question is rejected', () => {
  expectError(GAIN_NOUL, { type: 'score', score: 1 }, /type "score" does not match question type "noul"/);
  expectError(SPEAKER, { type: 'noul', noul: 0.5 }, /does not match/);
  expectError(GAIN_SCORE, { type: 'choice', choice: 'oren' }, /does not match/);
});

test('malformed raw answers (null, arrays, wrong primitives) are rejected', () => {
  expectError(SPEAKER, null);
  expectError(SPEAKER, undefined);
  expectError(SPEAKER, ['oren']);
  expectError(GAIN_NOUL, true);
  expectError(GAIN_SCORE, 'strong');
});

test('provenance is passed through unchanged', () => {
  assert.equal(expectOk(SPEAKER, 'oren', 'rule').provenance, 'rule');
  assert.equal(expectOk(SPEAKER, 'oren', 'fixture').provenance, 'fixture');
  assert.equal(expectOk(GAIN_NOUL, 0.1, 'native').provenance, 'native');
});

test('probabilities rounded to two decimals are accepted and renormalised (live Jev, many options)', () => {
  const keys = Array.from({ length: 62 }, (_, i) => `a${i}`);
  const raw = Object.fromEntries(keys.map((key, i) => [key, i === 0 ? 0.62 : i === 1 ? 0.21 : i === 2 ? 0.16 : 0]));
  const result = validateProbabilities(keys, raw);
  assert.ok(result.ok, result.ok ? '' : result.error);
  if (result.ok) assert.ok(Math.abs(Object.values(result.value).reduce((a, b) => a + b, 0) - 1) < 1e-9, 'renormalised to exactly 1');
  const two = validateProbabilities(['a', 'b'], { a: 0.5, b: 0.49 });
  assert.ok(two.ok, 'two options may be off by one rounding step');
  assert.ok(!validateProbabilities(['a', 'b'], { a: 0.5, b: 0.6 }).ok, 'a real error is still rejected');
});
