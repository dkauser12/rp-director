import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings } from '../../src/host.ts';
import { normalizeBaseSettings } from '../../src/migration.ts';
import { chooseReaction, defaultReactionSettings, normalizeReactionSettings, NPC_REACTION_GROUPS } from '../../src/npc-reaction.ts';

test('new installs use the staged pipeline with every module on', () => {
  const settings = defaultSettings();
  assert.equal(settings.pipeline, 'staged');
  assert.equal(settings.settingsRevision, 3);
  assert.deepEqual(settings.modules, { speaker: true, decisions: true, meters: true, secrets: true, lore: true, pacing: true, replyCheck: true });
});

test('saved pipeline and module choices survive a reload; bad values fall back', () => {
  const kept = normalizeBaseSettings(defaultSettings(), { pipeline: 'staged', modules: { speaker: false } });
  assert.equal(kept.pipeline, 'staged');
  assert.deepEqual(kept.modules, { speaker: false, decisions: true, meters: true, secrets: true, lore: true, pacing: true, replyCheck: true });
  const bad = normalizeBaseSettings(defaultSettings(), { pipeline: 'turbo', modules: { speaker: 'yes', decisions: 0 } });
  assert.equal(bad.pipeline, 'staged');
  assert.deepEqual(bad.modules, { speaker: true, decisions: true, meters: true, secrets: true, lore: true, pacing: true, replyCheck: true });
});

test('revision 3 forces staged for both old and explicitly selected legacy settings', () => {
  assert.equal(normalizeBaseSettings(defaultSettings(), { pipeline: 'legacy' }).pipeline, 'staged');
  const chosen = normalizeBaseSettings(defaultSettings(), { pipeline: 'legacy', settingsRevision: 2 });
  assert.equal(chosen.pipeline, 'staged');
  assert.equal(chosen.settingsRevision, 3);
});

test('hand-offs have their own reaction group with the NPC\'s possible answers', () => {
  const group = NPC_REACTION_GROUPS.find(g => g.id === 'initiative');
  assert.ok(group, 'initiative group exists');
  assert.deepEqual(group!.options.map(o => o.id), ['takes_lead', 'raises_stakes', 'hands_back', 'declines']);
  const settings = defaultReactionSettings();
  assert.deepEqual(Object.keys(settings.weights.initiative), ['takes_lead', 'raises_stakes', 'hands_back', 'declines']);
  const drawn = chooseReaction('initiative', settings, 'isla', 0);
  assert.equal(drawn.kind, 'initiative');
  assert.equal(drawn.outcome, 'takes_lead');
  assert.match(drawn.instruction, /initiative/);
});

test('settings saved before the initiative group get its defaults without losing other weights', () => {
  const old = { enabled: true, weights: { resolve: { press: 1, change_tactic: 0, concede: 0, withdraw: 0 }, secret: { hold: 1, slip: 0, reveal: 0 }, exposure: { unnoticed: 1, suspicion: 0, witnessed: 0 } } };
  const normalized = normalizeReactionSettings(old);
  assert.equal(normalized.weights.resolve.press, 1);
  assert.deepEqual(normalized.weights.initiative, defaultReactionSettings().weights.initiative);
});

test('lore stays off for anyone who had switched every other suite off', () => {
  const allOff = normalizeBaseSettings(defaultSettings(), { settingsRevision: 2, pipeline: 'staged', modules: { speaker: false, decisions: false, meters: false, secrets: false } });
  assert.equal(allOff.modules.lore, false);
  assert.equal(allOff.modules.pacing, false);
  assert.equal(allOff.modules.replyCheck, false);
  const someOn = normalizeBaseSettings(defaultSettings(), { settingsRevision: 2, pipeline: 'staged', modules: { speaker: true, decisions: false, meters: false, secrets: false } });
  assert.equal(someOn.modules.lore, true);
});


test('W2: total judge wait defaults to ten seconds and saved values are finite and bounded', () => {
  const defaults = defaultSettings();
  assert.equal(defaults.waitForJudgeSeconds, 10);
  for (const value of [undefined, null, NaN, Infinity, -1, '10']) {
    assert.equal(normalizeBaseSettings(defaults, { waitForJudgeSeconds: value }).waitForJudgeSeconds, 10);
  }
  for (const value of [0, 0.5, 10, 60, 120]) {
    assert.equal(normalizeBaseSettings(defaults, { waitForJudgeSeconds: value }).waitForJudgeSeconds, Math.max(2, value));
  }
  assert.equal(normalizeBaseSettings(defaults, { waitForJudgeSeconds: 1000 }).waitForJudgeSeconds, 120);
});


test('W3/W8: swipe choice and NPC roll review default on and preserve explicit opt-outs', () => {
  const defaults = defaultSettings();
  assert.equal(defaults.askWhenSwiping, true);
  assert.equal(defaults.reviewNpcRolls, true);
  const migrated = normalizeBaseSettings(defaults, { settingsRevision: 2 });
  assert.equal(migrated.askWhenSwiping, true);
  assert.equal(migrated.reviewNpcRolls, true);
  for (const value of [true, false]) {
    const saved = normalizeBaseSettings(defaults, { askWhenSwiping: value, reviewNpcRolls: value });
    assert.equal(saved.askWhenSwiping, value);
    assert.equal(saved.reviewNpcRolls, value);
    assert.deepEqual(normalizeBaseSettings(defaults, saved), saved);
  }
  const invalid = normalizeBaseSettings(defaults, { askWhenSwiping: 'false', reviewNpcRolls: 0 });
  assert.equal(invalid.askWhenSwiping, true);
  assert.equal(invalid.reviewNpcRolls, true);
});
