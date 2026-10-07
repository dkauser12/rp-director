import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presetById, presetDraft, registerLocalPresets } from '../../src/presets.ts';
import { effectiveProfile, setResolutionMethod } from '../../src/profiles.ts';
import type { DirectorSettings } from '../../src/types.ts';

const settings = (overrides: DirectorSettings['profileOverrides'] = {}): DirectorSettings => ({
  enabled: true,
  profileId: 'binding',
  connection: { kind: 'mock', baseUrl: '', model: '', stProfileId: '', mockScenario: 'gate-deferred' },
  showBadges: true,
  profileOverrides: overrides,
} as unknown as DirectorSettings);

test('loading a preset never changes the chosen resolution method', () => {
  const result = registerLocalPresets({
    schemaVersion: 1,
    presets: [{ ...presetById('adventure')!, id: 'method_probe', label: 'Method probe', description: 'A preset that carries a threshold recommendation.', resolutionMethod: 'threshold' }],
  });
  assert.deepEqual(result.warnings, []);
  const preset = presetById('method_probe')!;
  const draft = presetDraft(preset, 'sample');
  assert.equal(draft.method, 'sample');
  assert.deepEqual(draft.table.outcomes, preset.outcomes);
  assert.deepEqual(draft.table.bands, preset.bands);
  assert.match(draft.note ?? '', /threshold/);
});

test('a preset that agrees with the current method loads without a note', () => {
  const draft = presetDraft(presetById('adventure')!, 'sample');
  assert.equal(draft.method, 'sample');
  assert.equal(draft.note, null);
});

test('choosing dice persists immediately and keeps the applied table', () => {
  const table = presetById('political_sim')!;
  const s = settings({ binding: { outcomes: table.outcomes, bands: table.bands, resolutionMethod: 'threshold' } });
  setResolutionMethod(s, 'binding', 'sample');
  assert.equal(s.profileOverrides.binding!.resolutionMethod, 'sample');
  const { profile, warnings } = effectiveProfile(s);
  assert.deepEqual(warnings, []);
  assert.equal(profile.resolutionMethod, 'sample');
  assert.deepEqual(profile.outcomes.map(o => o.name), table.outcomes.map(o => o.name));
});

test('choosing dice with no applied table uses the built-in table', () => {
  const s = settings();
  setResolutionMethod(s, 'binding', 'sample');
  const { profile } = effectiveProfile(s);
  assert.equal(profile.resolutionMethod, 'sample');
  assert.equal(profile.id, 'binding');
});
