import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings } from '../../src/host.ts';
import { normalizeBaseSettings } from '../../src/migration.ts';
import { chooseReaction, defaultReactionSettings, normalizeReactionSettings, NPC_REACTION_GROUPS } from '../../src/npc-reaction.ts';

test('new installs use the staged pipeline with every module on', () => {
  const settings = defaultSettings();
  assert.equal(settings.pipeline, 'staged');
  assert.equal(settings.settingsRevision, 2);
  assert.deepEqual(settings.modules, { speaker: true, decisions: true, meters: true, secrets: true, lore: true });
});

test('saved pipeline and module choices survive a reload; bad values fall back', () => {
  const kept = normalizeBaseSettings(defaultSettings(), { pipeline: 'staged', modules: { speaker: false } });
  assert.equal(kept.pipeline, 'staged');
  assert.deepEqual(kept.modules, { speaker: false, decisions: true, meters: true, secrets: true, lore: true });
  const bad = normalizeBaseSettings(defaultSettings(), { pipeline: 'turbo', modules: { speaker: 'yes', decisions: 0 } });
  assert.equal(bad.pipeline, 'staged');
  assert.deepEqual(bad.modules, { speaker: true, decisions: true, meters: true, secrets: true, lore: true });
});

test('settings saved before revision 2 move to the staged pipeline once; a later Legacy choice stays', () => {
  assert.equal(normalizeBaseSettings(defaultSettings(), { pipeline: 'legacy' }).pipeline, 'staged');
  const chosen = normalizeBaseSettings(defaultSettings(), { pipeline: 'legacy', settingsRevision: 2 });
  assert.equal(chosen.pipeline, 'legacy');
  assert.equal(chosen.settingsRevision, 2);
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
  const someOn = normalizeBaseSettings(defaultSettings(), { settingsRevision: 2, pipeline: 'staged', modules: { speaker: true, decisions: false, meters: false, secrets: false } });
  assert.equal(someOn.modules.lore, true);
});
