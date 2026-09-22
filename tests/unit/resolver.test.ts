import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBands, normaliseSignal, findBand, sampleOutcome, resolveOutcome, gateAction, gainVariableId, freeze, effectsFor } from '../../src/resolver.ts';
import type { ActionSpec, Answer, PolicyBand } from '../../src/types.ts';
import { declareAction } from '../../src/templates.ts';
import { DEFAULT_OUTCOMES } from '../../src/table.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(here, '..', 'fixtures', rel), 'utf8'));
const profile = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'profiles', 'binding.json'), 'utf8'));
const bands: PolicyBand[] = profile.outcomes.bands;

const noul = (v: number): Answer => ({ type: 'noul', noul: v, confidence: null, provenance: 'fixture' });
const score = (v: number, levels: number): Answer => ({
  type: 'score', score: v, legend: Object.fromEntries(Array.from({ length: levels }, (_, i) => [String(i), `level ${i}`])), probabilities: null, confidence: 1, provenance: 'fixture',
});

test('profile bands validate', () => {
  const v = validateBands(bands);
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
});

test('band validation rejects gaps, bad weights, and inclusive interior bands', () => {
  const gap = structuredClone(bands); gap[1]!.lowerInclusive = 0.3;
  assert.equal(validateBands(gap).ok, false);
  const weights = structuredClone(bands); weights[0]!.sampleWeights.deferred = 0.5;
  assert.equal(validateBands(weights).ok, false);
  const precision = structuredClone(bands); precision[0]!.sampleWeights = { deferred: 0.33333, progress_only: 0.33333, achieved: 0.33334 };
  assert.equal(validateBands(precision).ok, false, 'unsupported weight precision is rejected, not silently changed');
  const inclusive = structuredClone(bands); inclusive[0]!.upperInclusive = true;
  assert.equal(validateBands(inclusive).ok, false);
});

test('all reference policy vectors resolve to the expected outcome', () => {
  const vectors = read('policy-vectors.json').cases as any[];
  assert.equal(vectors.length, 23);
  for (const v of vectors) {
    const answer = v.primitive === 'score' ? score(v.value, v.levels) : noul(v.value);
    const sig = normaliseSignal(answer);
    assert.equal(sig.ok, true, v.id);
    if (!sig.ok) continue;
    const out = resolveOutcome({ bands, method: v.method, signal: sig.signal, draw: v.method === 'sample' ? v.draw : null });
    assert.equal(out.ok, true, v.id);
    if (!out.ok) continue;
    assert.equal(out.value.outcome, v.expectedOutcome, v.id);
    if (v.method === 'threshold') assert.equal(out.value.draw, null, `${v.id}: threshold stores no draw`);
    else assert.equal(out.value.draw, v.draw, `${v.id}: sample records the draw`);
  }
});

test('M3-01: Noul 0.35 in threshold mode is deferred via band b1', () => {
  const sig = normaliseSignal(noul(0.35));
  assert.ok(sig.ok);
  const out = resolveOutcome({ bands, method: 'threshold', signal: sig.signal, draw: null });
  assert.ok(out.ok);
  assert.equal(out.value.outcome, 'deferred');
  assert.equal(out.value.band.id, 'b1');
});

test('M3-02: Score 1 of five levels normalises to 0.25 and uses row b1, not confidence', () => {
  const sig = normaliseSignal(score(1, 5));
  assert.ok(sig.ok);
  assert.equal(sig.signal.x, 0.25);
  const out = resolveOutcome({ bands, method: 'threshold', signal: sig.signal, draw: null });
  assert.ok(out.ok);
  assert.equal(out.value.band.id, 'b1');
  assert.equal(out.value.outcome, 'deferred');
});

test('M3-03: high confidence with a low score keeps the signal low', () => {
  const a = score(0, 5);
  a.confidence = 1;
  const sig = normaliseSignal(a);
  assert.ok(sig.ok);
  assert.equal(sig.signal.x, 0);
});

test('confidence and choice answers never drive the outcome', () => {
  const choice: Answer = { type: 'choice', choice: 'oren', probabilities: { oren: 1 }, confidence: 1, provenance: 'fixture' };
  assert.equal(normaliseSignal(choice).ok, false);
});

test('M3-13: a draw exactly on a cumulative boundary selects the next positive interval, never two', () => {
  const band = bands[1]!; // 0.70 / 0.25 / 0.05
  assert.equal(sampleOutcome(band, 0.7), 'progress_only');
  assert.equal(sampleOutcome(band, 0.95), 'achieved');
  assert.equal(sampleOutcome(band, 0.6999999), 'deferred');
  const zeroBand: PolicyBand = { ...band, sampleWeights: { deferred: 0.9, progress_only: 0.1, achieved: 0 } };
  assert.equal(sampleOutcome(zeroBand, 0.9999999), 'progress_only', 'a zero-weight interval is never selected');
  assert.throws(() => sampleOutcome(band, 1));
});

test('findBand covers the closed top and rejects out-of-range values', () => {
  assert.equal(findBand(bands, 1)?.id, 'b3');
  assert.equal(findBand(bands, 0)?.id, 'b0');
  assert.equal(findBand(bands, 1.01), null);
  assert.equal(findBand(bands, Number.NaN), null);
});

test('sample mode without a recorded draw is refused', () => {
  const sig = normaliseSignal(noul(0.5));
  assert.ok(sig.ok);
  assert.equal(resolveOutcome({ bands, method: 'sample', signal: sig.signal, draw: null }).ok, false);
});

const action = (): ActionSpec => ({
  actionId: 'action-demo-001',
  templateId: 'obtain_access',
  playerActorId: 'player',
  targetActorIds: ['oren'],
  attemptedAction: 'asks Oren to grant passage without a permit',
  requestedGain: 'permission to pass the gate now',
  applicability: 'favorable',
  preconditions: [],
  outcomeText: { deferred: { required: [], forbidden: [] }, progress_only: { required: [], forbidden: [] }, achieved: { required: [], forbidden: [] } },
  effectsByOutcome: { deferred: [], progress_only: [{ op: 'set_enum', variableId: 'gain:action-demo-001', value: 'partial' }], achieved: [{ op: 'set_enum', variableId: 'gain:action-demo-001', value: 'achieved' }] },
});

test('M3-05: a declared negative or inapplicable outcome receives no extra adjudication', () => {
  const a = action(); a.applicability = 'not_favorable';
  assert.deepEqual(gateAction(a, {}), { kind: 'skip', reason: 'not_favorable' });
});

test('M3-06: unresolved applicability pauses for confirmation', () => {
  const a = action(); a.applicability = 'unresolved';
  assert.deepEqual(gateAction(a, {}), { kind: 'pause', reason: 'unresolved_applicability' });
  const b = action(); b.requestedGain = '   ';
  assert.deepEqual(gateAction(b, {}), { kind: 'pause', reason: 'missing_gain' });
  assert.deepEqual(gateAction(null, {}), { kind: 'skip', reason: 'no_action' }, 'no declared action is a speaker-only turn, not a pause');
});

test('M3-07: an already-earned gain is not put at risk again, even when declared under a new action id', () => {
  const a = action();
  const gate = gateAction(a, { [gainVariableId(a)]: 'achieved' });
  assert.equal(gate.kind, 'rules');
  if (gate.kind === 'rules') assert.equal(gate.outcome.name, 'achieved');
  const again = { ...action(), actionId: 'action-demo-002', requestedGain: '  Permission to pass the gate NOW ' };
  assert.equal(gainVariableId(again), gainVariableId(a), 'gain identity is template + normalised gain text');
  assert.equal(gateAction(again, { [gainVariableId(a)]: 'achieved' }).kind, 'rules');
  const different = { ...action(), requestedGain: 'permission to enter the keep' };
  assert.notEqual(gainVariableId(different), gainVariableId(a));
});

test('a favorable action with no settled preconditions is adjudicated', () => {
  assert.deepEqual(gateAction(action(), {}), { kind: 'adjudicate' });
});

test('v2 identities separate actors and targets, canonicalise target order, and keep family out of explicit persistent facts', () => {
  const make = (over: Record<string, unknown> = {}) => declareAction({
    actionId: 'a1', templateId: 'contest_impose', actingActorId: 'mira', playerActorId: 'player', targetActorIds: ['oren', 'player'], attemptedAction: 'seizes the key', requestedGain: 'Mira controls the key', applicability: 'favorable', resolutionScope: 'persistent', persistentFactKey: 'key-control', opposed: true, ...over,
  } as never)!;
  const base = make();
  assert.equal(gainVariableId(make({ targetActorIds: ['player', 'oren'] })), gainVariableId(base), 'target order is not identity');
  assert.notEqual(gainVariableId(make({ actingActorId: 'player' })), gainVariableId(base), 'acting actor is identity');
  assert.notEqual(gainVariableId(make({ targetActorIds: ['oren'] })), gainVariableId(base), 'target set is identity');
  assert.equal(gainVariableId(make({ templateId: 'acquire_secure', requestedGain: 'the key is secured by Mira' })), gainVariableId(base), 'an explicit persistent fact survives method/family wording changes');
  assert.notEqual(gainVariableId(make({ actionId: 'a2', resolutionScope: 'attempt', persistentFactKey: '' })), gainVariableId(make({ actionId: 'a3', resolutionScope: 'attempt', persistentFactKey: '' })), 'attempt-scoped retries stay distinct');
});

test('actor policies adjudicate only their declared scope', () => {
  const npcContest = declareAction({ actionId: 'a', templateId: 'contest_impose', actingActorId: 'oren', playerActorId: 'player', targetActorIds: ['player'], attemptedAction: 'restrains Dom', requestedGain: 'Dom is restrained', applicability: 'not_favorable', opposed: true })!;
  const opts = (actorPolicy: any) => ({ actorPolicy, playerActorId: 'player', currentSceneId: 1 });
  assert.equal(gateAction(npcContest, {}, DEFAULT_OUTCOMES, opts('player_favorable')).kind, 'skip');
  assert.equal(gateAction(npcContest, {}, DEFAULT_OUTCOMES, opts('player_attempts')).kind, 'skip');
  assert.equal(gateAction(npcContest, {}, DEFAULT_OUTCOMES, opts('contested')).kind, 'adjudicate');
  assert.equal(gateAction(npcContest, {}, DEFAULT_OUTCOMES, opts('any_declared_actor')).kind, 'adjudicate');
  const unopposed = { ...npcContest, opposed: false };
  assert.deepEqual(gateAction(unopposed, {}, DEFAULT_OUTCOMES, opts('contested')), { kind: 'skip', reason: 'not_contested' });
  assert.equal(gateAction({ ...npcContest, uncertainConsequential: false }, {}, DEFAULT_OUTCOMES, opts('any_declared_actor')).kind, 'skip');
});

test('freeze copies inputs immutably and starts as prepared', () => {
  const a = action();
  const snapshot = { chatId: 'c', cursorBefore: 'c_x', stateRevision: 1, scopeId: 'shared-public', profileRevision: 'r1', catalogRevision: 'k', actorBindingRevision: 'b', state: {} as any };
  const r = freeze({ resolutionId: 'r1', previousResolutionId: null, action: a, snapshot, assessment: noul(0.35), decisionSource: 'provider', policyRevision: 'example-3.0.0', band: bands[1]!, method: 'threshold', draw: null, outcome: 'deferred', cursorBefore: null, generation: 1, providerKind: 'mock', requestedModel: 'mock', returnedModel: 'mock', now: 1 });
  assert.equal(r.status, 'prepared');
  a.requestedGain = 'changed after freeze';
  assert.equal(r.action.requestedGain, 'permission to pass the gate now');
  assert.deepEqual(effectsFor(r), []);
  assert.deepEqual(effectsFor({ ...r, outcome: 'achieved', outcomeTier: 'achieved' }), a.effectsByOutcome!.achieved);
  assert.deepEqual(effectsFor({ ...r, outcome: 'achieved' }), [], 'the meaning frozen with the ruling decides, not a later name change');
});
