import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_PROFILES, DEFAULT_BANDS, effectiveProfile, profileById } from '../../src/profiles.ts';
import { defaultSettings } from '../../src/host.ts';
import { validateBands } from '../../src/resolver.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const json = (name: string) => JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'profiles', name), 'utf8'));

test('built-in binding profile mirrors profiles/binding.json policy table and method', () => {
  const p = json('binding.json');
  assert.deepEqual(DEFAULT_BANDS, p.outcomes.bands);
  const poc = profileById('binding')!;
  assert.equal(poc.resolutionMethod, p.outcomes.resolutionMethod);
  assert.equal(poc.mode, p.outcomes.mode);
  assert.equal(poc.drivingQuestionId, p.outcomes.drivingQuestionId);
  assert.equal(poc.revision, p.revision);
  assert.equal(poc.budgets.maxRecentMessages, p.budgets.maxRecentMessages);
  assert.equal(poc.budgets.maxSerializedCharacters, p.budgets.maxSerializedCharacters);
  assert.equal(poc.budgets.maxQuestions, p.budgets.maxQuestions);
  assert.equal(poc.budgets.maxPreNetworkCalls, 1);
});

test('advisory profile is labelled advisory and has no binding outcomes', () => {
  const a = json('advisory.json');
  const adv = profileById('advisory')!;
  assert.equal(adv.mode, 'advisory');
  assert.equal(a.outcomes.mode, 'advisory');
  assert.equal(adv.swipePolicy, 'native');
  assert.ok(adv.advisoryInfluence > 0);
});

test('every built-in profile has a valid policy table', () => {
  for (const p of BUILTIN_PROFILES) assert.equal(validateBands(p.bands).ok, true, p.id);
});

test('M3-11: a user override changes the revision; an invalid override is dropped with a warning', () => {
  const settings = defaultSettings();
  const base = effectiveProfile(settings);
  assert.equal(base.profile.revision, 'example-3.1.0');
  const edited = structuredClone(DEFAULT_BANDS);
  edited[3]!.thresholdOutcome = 'progress_only';
  settings.profileOverrides['binding'] = { bands: edited };
  const over = effectiveProfile(settings);
  assert.notEqual(over.profile.revision, base.profile.revision);
  assert.equal(over.profile.bands[3]!.thresholdOutcome, 'progress_only');
  assert.deepEqual(over.warnings, []);
  const bad = structuredClone(DEFAULT_BANDS);
  bad[0]!.sampleWeights.deferred = 0.5;
  settings.profileOverrides['binding'] = { bands: bad };
  const rejected = effectiveProfile(settings);
  assert.ok(rejected.warnings.length > 0);
  assert.deepEqual(rejected.profile.bands, DEFAULT_BANDS);
});

test('profile names are simple and the handoff bundle ids still resolve', async () => {
  const { canonicalProfileId, LEGACY_PROFILE_IDS, DEFAULT_PROFILE_ID } = await import('../../src/profiles.ts');
  assert.deepEqual(BUILTIN_PROFILES.map(p => p.id), ['binding', 'binding-dice', 'advisory']);
  assert.deepEqual(BUILTIN_PROFILES.map(p => p.label), ['Binding', 'Binding + dice', 'Advisory']);
  for (const p of BUILTIN_PROFILES) assert.ok(p.description.length > 20, `${p.id} has a plain description`);
  assert.equal(DEFAULT_PROFILE_ID, 'binding');
  assert.equal(canonicalProfileId('proofdie-poc'), 'binding');
  assert.equal(canonicalProfileId('proofdie-sample'), 'binding-dice');
  assert.equal(canonicalProfileId('advisory'), 'advisory');
  assert.equal(profileById('proofdie-poc')!.id, 'binding');
  assert.equal(profileById('proofdie-sample')!.resolutionMethod, 'sample');
  assert.deepEqual(Object.keys(LEGACY_PROFILE_IDS).sort(), ['proofdie-poc', 'proofdie-sample']);
  // Stored settings that still carry a legacy id load the renamed profile, with overrides intact.
  const settings = defaultSettings();
  settings.profileId = 'proofdie-sample';
  assert.equal(effectiveProfile(settings).profile.id, 'binding-dice');
});

test('action contract labels are short', async () => {
  const { ACTION_TEMPLATES } = await import('../../src/templates.ts');
  assert.deepEqual(ACTION_TEMPLATES.map(t => t.label), ['Overcome / operate', 'Contest / impose', 'Evade / resist', 'Conceal / deceive', 'Detect / discover', 'Influence / negotiate', 'Acquire / secure']);
  assert.deepEqual(ACTION_TEMPLATES.map(t => t.id), ['overcome_operate', 'contest_impose', 'evade_resist', 'conceal_deceive', 'detect_discover', 'influence_negotiate', 'acquire_secure']);
  assert.ok(BUILTIN_PROFILES.every(p => p.actorPolicy === 'player_attempts'));
});
