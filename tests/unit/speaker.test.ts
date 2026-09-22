import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideSpeaker, eligibleActorIds, adjustmentsAreNeutral } from '../../src/speaker.ts';
import type { SpeakerInput } from '../../src/speaker.ts';
import type { Answer } from '../../src/types.ts';

const candidates = (disabled: string[] = []) => ['oren', 'mira', 'tessa'].map(id => ({ actorId: id, exclusions: disabled.includes(id) ? ['disabled'] : [] }));

const base = (over: Partial<SpeakerInput> = {}): SpeakerInput => ({
  candidates: candidates(),
  explicitActorId: null,
  includeYield: true,
  priors: {},
  repetitionFactor: 1,
  lastSpeakerActorId: null,
  answer: null,
  questionId: 'speaker',
  ...over,
});

const choice = (c: string, p: Record<string, number> | null, confidence: number | null = 1): Answer => ({ type: 'choice', choice: c, probabilities: p, confidence, provenance: 'fixture' });

test('M2-01: explicit eligible selection wins without any assessment', () => {
  const r = decideSpeaker(base({ explicitActorId: 'mira' }));
  assert.ok(r.ok);
  assert.equal(r.decision.selected, 'mira');
  assert.equal(r.decision.source, 'explicit');
});

test('M2-03: disabled members are absent from eligible options and never selected', () => {
  assert.deepEqual(eligibleActorIds(candidates(['mira'])), ['oren', 'tessa']);
  const r = decideSpeaker(base({ candidates: candidates(['mira']), explicitActorId: 'mira' }));
  assert.equal(r.ok, false);
  const r2 = decideSpeaker(base({ candidates: candidates(['mira']), answer: choice('mira', { mira: 1 }) }));
  assert.equal(r2.ok, false, 'a provider choice of an ineligible actor is rejected');
});

test('M2-04: a YIELD answer yields', () => {
  const r = decideSpeaker(base({ answer: choice('YIELD', { oren: 0, mira: 0, tessa: 0, YIELD: 1 }) }));
  assert.ok(r.ok);
  assert.equal(r.decision.selected, 'YIELD');
});

test('M2-05: ties break by stable group order and raw/adjusted stay visible', () => {
  const r = decideSpeaker(base({ answer: choice('mira', { oren: 0.5, mira: 0.5, tessa: 0, YIELD: 0 }, 0.5) }));
  assert.ok(r.ok);
  assert.equal(r.decision.selected, 'oren');
  assert.equal(r.decision.tieBroken, true);
  assert.deepEqual(r.decision.raw, { oren: 0.5, mira: 0.5, tessa: 0, YIELD: 0 });
  assert.ok(r.decision.adjusted);
  assert.equal(Math.round(r.decision.adjusted!.oren! * 100), 50);
});

test('M2-06: all adjusted weights zero yields without a fabricated distribution', () => {
  const r = decideSpeaker(base({ priors: { oren: 0, mira: 0, tessa: 0, YIELD: 0 }, answer: choice('oren', { oren: 0.6, mira: 0.4, tessa: 0, YIELD: 0 }) }));
  assert.ok(r.ok);
  assert.equal(r.decision.selected, 'YIELD');
  assert.equal(r.decision.source, 'all_zero');
});

test('priors and repetition adjust transparently', () => {
  const r = decideSpeaker(base({ priors: { mira: 3 }, answer: choice('oren', { oren: 0.5, mira: 0.3, tessa: 0.2, YIELD: 0 }) }));
  assert.ok(r.ok);
  assert.equal(r.decision.selected, 'mira');
  const rep = decideSpeaker(base({ repetitionFactor: 0.1, lastSpeakerActorId: 'oren', answer: choice('oren', { oren: 0.5, mira: 0.3, tessa: 0.2, YIELD: 0 }) }));
  assert.ok(rep.ok);
  assert.equal(rep.decision.selected, 'mira');
});

test('M2-13: a choice without a distribution is used only with neutral adjustments', () => {
  const ok = decideSpeaker(base({ answer: choice('oren', null, null) }));
  assert.ok(ok.ok);
  assert.equal(ok.decision.selected, 'oren');
  assert.equal(ok.decision.raw, null);
  const bad = decideSpeaker(base({ priors: { mira: 2 }, answer: choice('oren', null, null) }));
  assert.equal(bad.ok, false);
  assert.equal(adjustmentsAreNeutral({ priors: { oren: 1 }, repetitionFactor: 1 }, ['oren']), true);
  assert.equal(adjustmentsAreNeutral({ priors: {}, repetitionFactor: 0.5 }, ['oren']), false);
});

test('ambiguous speaker without an assessment is an error, not a guess', () => {
  const r = decideSpeaker(base());
  assert.equal(r.ok, false);
});

test('no eligible actors yields', () => {
  const r = decideSpeaker(base({ candidates: candidates(['oren', 'mira', 'tessa']) }));
  assert.ok(r.ok);
  assert.equal(r.decision.selected, 'YIELD');
});
