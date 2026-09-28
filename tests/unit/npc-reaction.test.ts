import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseReaction, defaultReactionSettings, normalizeReactionSettings, NPC_REACTION_GROUPS, reactionQuestion } from '../../src/npc-reaction.ts';
import type { ReactionKind } from '../../src/npc-reaction.ts';
import { checkBatch } from '../../src/questions.ts';

test('reaction trigger is one independent choice that can share the pre-pass batch', () => {
  const question = reactionQuestion();
  assert.equal(question.type, 'choice');
  if (question.type !== 'choice') return;
  assert.deepEqual(Object.keys(question.criteria), ['none', 'resolve', 'secret', 'exposure']);
  assert.equal(checkBatch({ npc_reaction: question }, 1, ['shared-public']).ok, true);
});

test('configured reaction boundaries are deterministic and half-open', () => {
  const settings = defaultReactionSettings();
  for (const [draw, outcome] of [[0, 'press'], [0.399999, 'press'], [0.4, 'change_tactic'], [0.799999, 'change_tactic'], [0.8, 'concede'], [0.949999, 'concede'], [0.95, 'withdraw'], [1 - Number.EPSILON, 'withdraw']] as const) {
    assert.equal(chooseReaction('resolve', settings, 'npc-a', draw).outcome, outcome);
  }
  assert.equal(chooseReaction('secret', settings, 'npc-a', 0.75).outcome, 'slip');
  assert.equal(chooseReaction('secret', settings, 'npc-a', 0.95).outcome, 'reveal');
  assert.equal(chooseReaction('exposure', settings, 'npc-a', 0.6).outcome, 'suspicion');
  assert.equal(chooseReaction('exposure', settings, 'npc-a', 0.9).outcome, 'witnessed');
});

test('relative weights need not total 100 and zero-weight outcomes cannot be selected', () => {
  const settings = defaultReactionSettings();
  settings.weights.resolve = { press: 0, change_tactic: 2, concede: 0, withdraw: 6 };
  assert.equal(chooseReaction('resolve', settings, 'npc-a', 0).outcome, 'change_tactic');
  assert.equal(chooseReaction('resolve', settings, 'npc-a', 0.249999).outcome, 'change_tactic');
  assert.equal(chooseReaction('resolve', settings, 'npc-a', 0.25).outcome, 'withdraw');
  assert.equal(chooseReaction('resolve', settings, 'npc-a', 1 - Number.EPSILON).outcome, 'withdraw');
  settings.weights.resolve = { press: 0, change_tactic: 2, concede: 0, withdraw: 0 };
  assert.equal(chooseReaction('resolve', settings, 'npc-a', 1 - Number.EPSILON).outcome, 'change_tactic');
});

test('invalid distributions fail without an invented outcome', () => {
  for (const bad of [-1, NaN, Infinity, '40', null]) {
    const settings = defaultReactionSettings();
    settings.weights.resolve.press = bad as number;
    assert.throws(() => chooseReaction('resolve', settings, 'npc-a', 0), /weight/i);
  }
  const empty = defaultReactionSettings();
  empty.weights.secret = { hold: 0, slip: 0, reveal: 0 };
  assert.throws(() => chooseReaction('secret', empty, 'npc-a', 0), /positive total/);
  const overflow = defaultReactionSettings();
  overflow.weights.secret = { hold: Number.MAX_VALUE, slip: Number.MAX_VALUE, reveal: 0 };
  assert.throws(() => chooseReaction('secret', overflow, 'npc-a', 0), /finite positive total/);
});

test('unknown and missing outcome keys, invalid draws and disabled settings are refused', () => {
  const unknown = defaultReactionSettings();
  unknown.weights.secret.confess = 1;
  assert.throws(() => chooseReaction('secret', unknown, 'npc-a', 0), /catalog outcome keys/);
  const missing = defaultReactionSettings();
  delete missing.weights.secret.hold;
  assert.throws(() => chooseReaction('secret', missing, 'npc-a', 0), /catalog outcome keys/);
  const settings = defaultReactionSettings();
  for (const draw of [-0.01, 1, Infinity, NaN]) assert.throws(() => chooseReaction('secret', settings, 'npc-a', draw), /draw/);
  assert.throws(() => chooseReaction('invented' as ReactionKind, settings, 'npc-a', 0), /Unknown/);
  assert.throws(() => chooseReaction('secret', settings, ' ', 0), /actor ID/);
  settings.enabled = false;
  assert.throws(() => chooseReaction('secret', settings, 'npc-a', 0), /disabled/);
});

test('defaults are independent and selected results remain immutable after settings change', () => {
  const settings = defaultReactionSettings();
  const original = structuredClone(settings);
  const first = chooseReaction('resolve', settings, 'npc-a', 0);
  const second = chooseReaction('resolve', settings, 'npc-a', 0);
  assert.deepEqual(settings, original);
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.ok(Object.isFrozen(first));
  assert.throws(() => { (first as { outcome: string }).outcome = 'withdraw'; }, TypeError);
  settings.weights.resolve.press = 0;
  assert.equal(defaultReactionSettings().weights.resolve.press, 40);
  assert.equal(first.outcome, 'press');
  assert.equal(first.actorId, 'npc-a');
  assert.ok(Object.isFrozen(NPC_REACTION_GROUPS));
  assert.ok(Object.isFrozen(NPC_REACTION_GROUPS[0]!.options[0]));
});

test('saved settings migration preserves disabled and valid groups while repairing only malformed groups', () => {
  assert.deepEqual(normalizeReactionSettings(undefined), defaultReactionSettings());
  const saved = {
    enabled: false,
    weights: {
      resolve: { press: 1, change_tactic: 2, concede: 3, withdraw: 4 },
      secret: { hold: 75, slip: 20, reveal: 5, extra: 1 },
      exposure: { unnoticed: 0, suspicion: 0, witnessed: 0 },
      invented: { arbitrary: 100 },
    },
  };
  const normalized = normalizeReactionSettings(saved);
  assert.equal(normalized.enabled, false);
  assert.deepEqual(normalized.weights.resolve, saved.weights.resolve);
  assert.deepEqual(normalized.weights.secret, defaultReactionSettings().weights.secret);
  assert.deepEqual(normalized.weights.exposure, defaultReactionSettings().weights.exposure);
  assert.equal('invented' in normalized.weights, false);
  normalized.weights.resolve.press = 99;
  assert.equal(saved.weights.resolve.press, 1);
});
