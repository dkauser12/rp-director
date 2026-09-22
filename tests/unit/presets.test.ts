import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerLocalPresets, TABLE_PRESETS, presetById } from '../../src/presets.ts';
import { DEFAULT_OUTCOMES, validateTable } from '../../src/table.ts';
import { DEFAULT_BANDS } from '../../src/profiles.ts';
import { resolveOutcome } from '../../src/resolver.ts';
import { buildTableTestRequest } from '../../src/tabletest.ts';
import { bindingBlock } from '../../src/prompts.ts';
import { declareAction } from '../../src/templates.ts';

test('the four genre presets exist alongside the standard table', () => {
  assert.deepEqual(TABLE_PRESETS.map(p => p.id), ['standard', 'adventure', 'dating_sim', 'rom_com', 'political_sim']);
  for (const p of TABLE_PRESETS) {
    assert.ok(p.label.length > 3 && p.description.length > 20, p.id);
    assert.equal(presetById(p.id)!.id, p.id);
  }
  assert.equal(presetById('nope'), null);
});

test('every preset is a valid table that resolves the whole 0 to 1 range, in both methods', () => {
  for (const p of TABLE_PRESETS) {
    assert.deepEqual(validateTable({ outcomes: p.outcomes, bands: p.bands }).errors, [], p.id);
    for (const x of [0, 0.05, 0.2, 0.33, 0.5, 0.66, 0.79, 0.9, 1]) {
      const t = resolveOutcome({ bands: p.bands, outcomes: p.outcomes, method: 'threshold', signal: { x, primitive: 'noul', levels: null }, draw: null });
      assert.ok(t.ok, `${p.id} threshold x=${x}`);
      for (const draw of [0, 0.5, 0.9999]) {
        const s = resolveOutcome({ bands: p.bands, outcomes: p.outcomes, method: 'sample', signal: { x, primitive: 'noul', levels: null }, draw });
        assert.ok(s.ok, `${p.id} sample x=${x} draw=${draw}`);
      }
    }
    assert.ok(Object.keys(buildTableTestRequest({ outcomes: p.outcomes, bands: p.bands }, 'gain_noul', 'r').questions).length === 3, `${p.id} can be sent to the table test`);
  }
});

test('the standard preset is exactly the built-in table; the genre presets allow real failure', () => {
  const standard = presetById('standard')!;
  assert.deepEqual(standard.outcomes, DEFAULT_OUTCOMES);
  assert.deepEqual(standard.bands, DEFAULT_BANDS);
  assert.equal(standard.outcomes.some(o => o.final && o.records !== 'achieved'), false);
  // Adventure and political sim can close a door for good; every genre's worst ruling records something.
  assert.deepEqual(presetById('adventure')!.outcomes.filter(o => o.final).map(o => o.name), ['blocked', 'success']);
  assert.deepEqual(presetById('political_sim')!.outcomes.filter(o => o.final).map(o => o.name), ['refused', 'secured']);
  for (const id of ['adventure', 'dating_sim', 'rom_com', 'political_sim']) {
    const p = presetById(id)!;
    assert.ok(p.outcomes[0]!.records, `${id}: the worst ruling is recorded`);
    assert.equal(p.outcomes.at(-1)!.records, 'achieved', `${id}: the best ruling records the gain`);
    const low = resolveOutcome({ bands: p.bands, outcomes: p.outcomes, method: 'threshold', signal: { x: 0, primitive: 'noul', levels: null }, draw: null });
    const high = resolveOutcome({ bands: p.bands, outcomes: p.outcomes, method: 'threshold', signal: { x: 1, primitive: 'noul', levels: null }, draw: null });
    assert.ok(low.ok && high.ok);
    assert.equal(low.value.outcome, p.outcomes[0]!.name);
    assert.equal(high.value.outcome, p.outcomes.at(-1)!.name);
  }
});

test('preset instructions fill their placeholders cleanly', () => {
  const action = declareAction({ actionId: 'a', templateId: 'secure_cooperation', playerActorId: 'player', targetActorIds: ['x'], attemptedAction: 'asks the senator for her vote', requestedGain: 'the senator votes for the bill', applicability: 'favorable' })!;
  for (const p of TABLE_PRESETS) {
    for (const o of p.outcomes) {
      const block = bindingBlock({ action, outcome: o.name, instruction: o.instruction, speakerName: 'Senator Vale', playerName: 'Dom', targetNames: ['Senator Vale'] });
      assert.doesNotMatch(block, /\{\{/, `${p.id}.${o.name} leaves no placeholder behind`);
      assert.match(block, new RegExp(`Ruling: ${o.name}\\.`));
    }
  }
});

test('local-only preset documents are strictly validated and may carry safe recommendations', () => {
  const before = TABLE_PRESETS.length;
  const result = registerLocalPresets({
    schemaVersion: 1,
    presets: [{
      id: 'local_test', label: 'Local test', description: 'A local-only test table with safe declarative fields only.', actorPolicy: 'any_declared_actor', resolutionMethod: 'threshold',
      outcomes: [
        { name: 'no', instruction: 'The bounded result is not achieved.', records: '', final: false },
        { name: 'yes', instruction: 'The bounded result is achieved exactly.', records: 'achieved', final: true },
      ],
      bands: [
        { id: 'b0', lowerInclusive: 0, upper: 0.5, upperInclusive: false, thresholdOutcome: 'no', sampleWeights: { no: 0.8, yes: 0.2 } },
        { id: 'b1', lowerInclusive: 0.5, upper: 1, upperInclusive: true, thresholdOutcome: 'yes', sampleWeights: { no: 0.2, yes: 0.8 } },
      ],
    }],
  });
  assert.deepEqual(result, { loaded: ['local_test'], warnings: [] });
  assert.deepEqual([presetById('local_test')!.actorPolicy, presetById('local_test')!.resolutionMethod], ['any_declared_actor', 'threshold']);
  TABLE_PRESETS.splice(before);
  const bad = registerLocalPresets({ schemaVersion: 1, presets: [{ id: '../bad', label: 'Bad', description: 'bad', outcomes: [], bands: [], script: 'alert(1)' }] });
  assert.equal(bad.loaded.length, 0);
  assert.ok(bad.warnings.length > 0);
});
