import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_OUTCOMES, LEGACY_TIER_DEFAULTS, MAX_BANDS, MAX_OUTCOMES, NAME_MAX_LENGTH, normalizeOutcome, settledOutcome,
  addBand, addOutcome, bandId, canAddBand, canAddOutcome, canRemoveBand, canRemoveOutcome, cloneTable,
  removeBand, removeOutcome, renameOutcome, sanitizeName, setBandUpper, validateOutcomes, validateTable, weightSum, widestBandIndex,
} from '../../src/table.ts';
import type { PolicyTable } from '../../src/table.ts';
import { DEFAULT_BANDS, effectiveProfile } from '../../src/profiles.ts';
import { defaultSettings } from '../../src/host.ts';
import { effectsFor, freeze, gainVariableId, gateAction, instructionForResolution, resolveOutcome, sampleOutcome, tierForResolution } from '../../src/resolver.ts';
import { bindingBlock } from '../../src/prompts.ts';
import { declareAction } from '../../src/templates.ts';

const base = (): PolicyTable => cloneTable({ outcomes: DEFAULT_OUTCOMES, bands: DEFAULT_BANDS });

test('names: spaces become underscores and unsupported characters are removed', () => {
  assert.equal(sanitizeName('not yet'), 'not_yet');
  assert.equal(sanitizeName('not '), 'not_', 'a trailing space stays an underscore while typing');
  assert.equal(sanitizeName('not ', true), 'not', 'and is trimmed when the field is committed');
  assert.equal(sanitizeName('big win!'), 'big_win');
  assert.equal(sanitizeName('crit-success'), 'crit_success');
  assert.equal(sanitizeName('  __lead'), 'lead');
  assert.equal(sanitizeName('a   b'), 'a_b');
  assert.equal(sanitizeName('w:achieved'), 'wachieved', 'the w: label can never be typed into a name');
  assert.equal(sanitizeName('Ünïcode näme'), 'Unicode_name');
  assert.equal(sanitizeName('a|b{c}"d\'e'), 'abcde');
  assert.equal(sanitizeName('x'.repeat(80)).length, NAME_MAX_LENGTH);
  assert.equal(sanitizeName('YIELD'), 'YIELD', 'case is kept');
});

const col = (name: string, over: Partial<{ instruction: string; records: string; final: boolean }> = {}) => ({ name, instruction: 'Tell the writer what happens.', records: '', final: false, ...over });

test('outcome columns: at least two, unique, identifier-shaped, and fully player-defined', () => {
  assert.equal(validateOutcomes(DEFAULT_OUTCOMES).ok, true);
  assert.equal(validateOutcomes([DEFAULT_OUTCOMES[0]!]).ok, false);
  assert.match(validateOutcomes([col('yes'), col('YES')]).errors.join(' '), /duplicate/);
  assert.match(validateOutcomes([col('1st'), col('no')]).errors.join(' '), /starting with a letter/);
  assert.match(validateOutcomes([col(''), col('no')]).errors.join(' '), /empty/);
  assert.match(validateOutcomes([col('a', { instruction: '   ' }), col('no')]).errors.join(' '), /say what the writer is told/);
  assert.match(validateOutcomes([col('a', { records: 'not ok!' }), col('no')]).errors.join(' '), /recorded value/);
  assert.match(validateOutcomes([col('a', { final: true }), col('no')]).errors.join(' '), /only stand once accepted if it records a value/);
  assert.equal(validateOutcomes([col('failed', { records: 'failed', final: true }), col('won', { records: 'achieved', final: true })]).ok, true, 'a real, final failure is a valid outcome');
});

test('the built-in table validates and ids are b0..bN', () => {
  const t = base();
  assert.deepEqual(validateTable(t).errors, []);
  assert.deepEqual(t.bands.map(b => b.id), ['b0', 'b1', 'b2', 'b3']);
  assert.equal(bandId(12), 'b12');
});

test('add row splits the widest band, keeps the rows tiling 0 to 1, and renumbers', () => {
  let t = base();
  t = setBandUpper(t, 0, 0.1); // b1 becomes the widest: 0.1 .. 0.5
  assert.equal(widestBandIndex(t), 1);
  const next = addBand(t);
  assert.equal(next.bands.length, 5);
  assert.deepEqual(next.bands.map(b => b.id), ['b0', 'b1', 'b2', 'b3', 'b4']);
  assert.deepEqual(next.bands.map(b => [b.lowerInclusive, b.upper]), [[0, 0.1], [0.1, 0.3], [0.3, 0.5], [0.5, 0.75], [0.75, 1]]);
  assert.equal(next.bands[2]!.thresholdOutcome, next.bands[1]!.thresholdOutcome, 'the new row copies the split row');
  assert.deepEqual(next.bands.map(b => b.upperInclusive), [false, false, false, false, true]);
  assert.deepEqual(validateTable(next).errors, []);
  assert.equal(t.bands.length, 4, 'operations are pure');
});

test('remove row hands its range to the row above, or below for the first row', () => {
  const t = base();
  const mid = removeBand(t, 2);
  assert.deepEqual(mid.bands.map(b => [b.id, b.lowerInclusive, b.upper]), [['b0', 0, 0.25], ['b1', 0.25, 0.75], ['b2', 0.75, 1]]);
  assert.deepEqual(validateTable(mid).errors, []);
  const first = removeBand(t, 0);
  assert.deepEqual(first.bands.map(b => [b.id, b.lowerInclusive, b.upper]), [['b0', 0, 0.5], ['b1', 0.5, 0.75], ['b2', 0.75, 1]]);
  const last = removeBand(t, 3);
  assert.equal(last.bands.at(-1)!.upper, 1);
  assert.equal(last.bands.at(-1)!.upperInclusive, true);
  assert.deepEqual(validateTable(last).errors, []);
});

test('editing "to" moves the next row\'s "from"; the last row always ends at 1', () => {
  const t = setBandUpper(base(), 1, 0.6);
  assert.equal(t.bands[1]!.upper, 0.6);
  assert.equal(t.bands[2]!.lowerInclusive, 0.6);
  assert.deepEqual(validateTable(t).errors, []);
  const unchanged = setBandUpper(base(), 3, 0.9);
  assert.equal(unchanged.bands[3]!.upper, 1);
  const bad = setBandUpper(base(), 0, 0.9);
  assert.equal(validateTable(bad).ok, false, 'an overlapping boundary is reported, not silently fixed');
});

test('add column gives every row a zero weight; remove column leaves a named error on rows that used it', () => {
  const added = addOutcome(base());
  assert.equal(added.outcomes.length, 4);
  assert.equal(added.outcomes[3]!.name, 'outcome_4');
  assert.deepEqual(added.outcomes[3], { name: 'outcome_4', instruction: '', records: '', final: false });
  assert.ok(added.bands.every(b => b.sampleWeights.outcome_4 === 0));
  assert.match(validateTable(added).errors.join(' '), /outcome "outcome_4": say what the writer is told/, 'a new column must be defined before it can be applied');
  added.outcomes[3]!.instruction = 'The attempt fails outright.';
  assert.deepEqual(validateTable(added).errors, []);
  const removed = removeOutcome(base(), 2); // drops "achieved"
  assert.ok(removed.bands.every(b => !Object.hasOwn(b.sampleWeights, 'achieved')));
  const v = validateTable(removed);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' | '), /band b3: outcome "achieved" is not one of the columns/);
  assert.match(v.errors.join(' | '), /weights must sum to 1/);
});

test('renaming a column updates every weight and every row that referenced it, keeping column order', () => {
  const t = renameOutcome(base(), 0, 'not yet!');
  assert.deepEqual(t.outcomes.map(o => o.name), ['not_yet', 'progress_only', 'achieved']);
  assert.deepEqual(Object.keys(t.bands[0]!.sampleWeights), ['not_yet', 'progress_only', 'achieved']);
  assert.equal(t.bands[0]!.thresholdOutcome, 'not_yet');
  assert.equal(t.bands[1]!.thresholdOutcome, 'not_yet');
  assert.equal(t.bands[3]!.thresholdOutcome, 'achieved');
  assert.deepEqual(validateTable(t).errors, []);
  assert.deepEqual(renameOutcome(base(), 0, '!!!').outcomes.map(o => o.name), DEFAULT_OUTCOMES.map(o => o.name), 'an empty result is ignored');
});

test('limits: add buttons disappear at 255 (Jev\'s Choice option limit); remove stops at 2 columns and 1 row', () => {
  let cols = base();
  while (canAddOutcome(cols)) cols = addOutcome(cols);
  assert.equal(cols.outcomes.length, MAX_OUTCOMES);
  assert.equal(MAX_OUTCOMES, 255);
  assert.equal(addOutcome(cols).outcomes.length, MAX_OUTCOMES, 'adding past the bound is a no-op');
  for (const o of cols.outcomes) if (!o.instruction) o.instruction = 'Defined by the player.';
  assert.deepEqual(validateTable(cols).errors, []);

  let rows = base();
  while (canAddBand(rows)) rows = addBand(rows);
  assert.equal(rows.bands.length, MAX_BANDS);
  assert.deepEqual(validateTable(rows).errors, []);
  assert.equal(rows.bands.at(-1)!.id, 'b254');

  let few = base();
  while (canRemoveOutcome(few)) few = removeOutcome(few, few.outcomes.length - 1);
  assert.equal(few.outcomes.length, 2);
  let one = base();
  while (canRemoveBand(one)) one = removeBand(one, one.bands.length - 1);
  assert.equal(one.bands.length, 1);
  assert.deepEqual([one.bands[0]!.lowerInclusive, one.bands[0]!.upper, one.bands[0]!.upperInclusive], [0, 1, true]);
});

const custom = (): PolicyTable => ({
  outcomes: [
    { name: 'shut_out', instruction: 'The attempt fails and {{target}} will not reconsider. Show the door closing.', records: 'failed', final: true },
    { name: 'not_yet', instruction: '{{gain}} is not given in this reply.', records: '', final: false },
    { name: 'foot_in_door', instruction: 'Only a partial step toward {{gain}} happens.', records: 'partial', final: false },
    { name: 'yes', instruction: '{{gain}} is given exactly as asked.', records: 'achieved', final: true },
  ],
  bands: [
    { id: 'b0', lowerInclusive: 0, upper: 0.2, upperInclusive: false, thresholdOutcome: 'shut_out', sampleWeights: { shut_out: 0.5, not_yet: 0.5, foot_in_door: 0, yes: 0 } },
    { id: 'b1', lowerInclusive: 0.2, upper: 0.6, upperInclusive: false, thresholdOutcome: 'not_yet', sampleWeights: { shut_out: 0.1, not_yet: 0.6, foot_in_door: 0.3, yes: 0 } },
    { id: 'b2', lowerInclusive: 0.6, upper: 1, upperInclusive: true, thresholdOutcome: 'yes', sampleWeights: { shut_out: 0, not_yet: 0.1, foot_in_door: 0.3, yes: 0.6 } },
  ],
});

const gateAction_ = (gain: string) => declareAction({ actionId: 'a' + gain.length, templateId: 'acquire_secure', actingActorId: 'player', playerActorId: 'player', targetActorIds: ['oren'], attemptedAction: 'asks Oren', requestedGain: gain, applicability: 'favorable', resolutionScope: 'persistent', persistentFactKey: 'gate-passage' })!;
const snapshot = { chatId: 'c', cursorBefore: 'x', stateRevision: 0, scopeId: 's', profileRevision: 'r', catalogRevision: '', actorBindingRevision: '', state: {} };

test('a custom four-column table resolves by name and returns the whole player-defined outcome', () => {
  const t = custom();
  assert.deepEqual(validateTable(t).errors, []);
  const low = resolveOutcome({ bands: t.bands, outcomes: t.outcomes, method: 'threshold', signal: { x: 0.1, primitive: 'noul', levels: null }, draw: null });
  assert.ok(low.ok);
  assert.deepEqual([low.value.outcome, low.value.def.records, low.value.def.final, low.value.band.id], ['shut_out', 'failed', true, 'b0']);
  const high = resolveOutcome({ bands: t.bands, outcomes: t.outcomes, method: 'threshold', signal: { x: 1, primitive: 'noul', levels: null }, draw: null });
  assert.ok(high.ok);
  assert.deepEqual([high.value.outcome, high.value.def.records], ['yes', 'achieved']);
  // dice mode walks the columns in table order
  assert.equal(sampleOutcome(t.bands[1]!, 0.05, t.outcomes.map(o => o.name)), 'shut_out');
  assert.equal(sampleOutcome(t.bands[1]!, 0.1, t.outcomes.map(o => o.name)), 'not_yet');
  assert.equal(sampleOutcome(t.bands[1]!, 0.7, t.outcomes.map(o => o.name)), 'foot_in_door');
  const rolled = resolveOutcome({ bands: t.bands, outcomes: t.outcomes, method: 'sample', signal: { x: 0.9, primitive: 'noul', levels: null }, draw: 0.95 });
  assert.ok(rolled.ok);
  assert.deepEqual([rolled.value.outcome, rolled.value.draw], ['yes', 0.95]);
  assert.equal(weightSum(t.bands[1]!, t.outcomes.map(o => o.name)), 1);
});

test('a row that names a missing column is refused at resolution time too', () => {
  const t = custom();
  t.bands[0]!.thresholdOutcome = 'gone';
  const r = resolveOutcome({ bands: t.bands, outcomes: t.outcomes, method: 'threshold', signal: { x: 0, primitive: 'noul', levels: null }, draw: null });
  assert.equal(r.ok, false);
});

test('actual failure: a player-defined failing outcome is frozen, instructs the writer, and records its own value', () => {
  const t = custom();
  const action = gateAction_('passage now');
  const low = resolveOutcome({ bands: t.bands, outcomes: t.outcomes, method: 'threshold', signal: { x: 0.05, primitive: 'noul', levels: null }, draw: null });
  assert.ok(low.ok);
  const res = freeze({ resolutionId: 'r1', previousResolutionId: null, action, snapshot, assessment: null, decisionSource: 'provider', policyRevision: 'r', band: low.value.band, method: 'threshold', draw: null, outcome: low.value.outcome, def: low.value.def, cursorBefore: null, generation: 1, providerKind: 'mock', requestedModel: null, returnedModel: null, now: 1 });
  assert.deepEqual([res.outcome, res.outcomeRecords, res.outcomeFinal, res.outcomeTier], ['shut_out', 'failed', true, undefined]);
  assert.deepEqual(effectsFor(res), [{ op: 'set_enum', variableId: gainVariableId(action), value: 'failed' }], 'the failure is recorded, not just narrated');
  const block = bindingBlock({ action, outcome: res.outcome, instruction: instructionForResolution(res), speakerName: 'Oren', playerName: 'Dom', targetNames: ['Oren'] });
  assert.match(block, /Ruling: shut_out\./);
  assert.match(block, /The attempt fails and Oren will not reconsider\. Show the door closing\./);
  assert.doesNotMatch(block, /\{\{/, 'placeholders are filled before injection');
  // an outcome that records nothing applies no effect
  const mid = resolveOutcome({ bands: t.bands, outcomes: t.outcomes, method: 'threshold', signal: { x: 0.4, primitive: 'noul', levels: null }, draw: null });
  assert.ok(mid.ok);
  const none = freeze({ resolutionId: 'r2', previousResolutionId: null, action, snapshot, assessment: null, decisionSource: 'provider', policyRevision: 'r', band: mid.value.band, method: 'threshold', draw: null, outcome: mid.value.outcome, def: mid.value.def, cursorBefore: null, generation: 1, providerKind: 'mock', requestedModel: null, returnedModel: null, now: 1 });
  assert.deepEqual(effectsFor(none), []);
});

test('a final ruling stands: the same gain is not judged again, whether it was a success or a failure', () => {
  const t = custom();
  const action = gateAction_('passage now');
  const gainVar = gainVariableId(action);
  assert.deepEqual(gateAction(action, {}, t.outcomes), { kind: 'adjudicate' });
  const failed = gateAction(action, { [gainVar]: 'failed' }, t.outcomes, { actorPolicy: 'player_favorable', playerActorId: 'player', currentSceneId: 1, settledGains: { [gainVar]: { variableId: gainVar, resolutionId: 'rf', outcome: t.outcomes[0]!, scope: 'persistent', sceneId: null } } });
  assert.equal(failed.kind, 'rules');
  if (failed.kind === 'rules') assert.equal(failed.outcome.name, 'shut_out', 'a final failure closes the door without a judge call');
  const won = gateAction(action, { [gainVar]: 'achieved' }, t.outcomes, { actorPolicy: 'player_favorable', playerActorId: 'player', currentSceneId: 1, settledGains: { [gainVar]: { variableId: gainVar, resolutionId: 'rw', outcome: t.outcomes[3]!, scope: 'persistent', sceneId: null } } });
  assert.equal(won.kind, 'rules');
  if (won.kind === 'rules') assert.equal(won.outcome.name, 'yes');
  assert.deepEqual(gateAction(action, { [gainVar]: 'partial' }, t.outcomes), { kind: 'adjudicate' }, 'a variable without a frozen final settlement leaves the gain open');
  assert.deepEqual(gateAction(gateAction_('a different gain'), { [gainVar]: 'failed' }, t.outcomes), { kind: 'adjudicate' }, 'a different request is a different gain');
  assert.equal(settledOutcome(t.outcomes, ''), null);
  assert.equal(settledOutcome(t.outcomes, 'unknown_value'), null);
});

test('rulings and tables saved by the earlier build still read correctly', () => {
  assert.equal(tierForResolution({ outcome: 'progress_only' }), 'progress_only');
  assert.equal(tierForResolution({ outcome: 'something_renamed' }), 'deferred', 'an unknown name never grants anything');
  assert.equal(instructionForResolution({ outcome: 'achieved', outcomeTier: 'achieved', outcomeNote: 'Exactly as asked.' }), LEGACY_TIER_DEFAULTS.achieved.instruction + ' Exactly as asked.');
  const migrated = normalizeOutcome({ name: 'yes', tier: 'achieved', note: 'Make it warm.' });
  assert.deepEqual(migrated, { name: 'yes', instruction: LEGACY_TIER_DEFAULTS.achieved.instruction + ' Make it warm.', records: 'achieved', final: true });
  assert.deepEqual(normalizeOutcome({ name: 'no', tier: 'deferred', note: '' }).records, '');
  assert.deepEqual(normalizeOutcome(custom().outcomes[0]), custom().outcomes[0], 'current-shape columns pass through unchanged');
  const settings = defaultSettings();
  settings.profileOverrides.binding = { outcomes: [{ name: 'nope', tier: 'deferred', note: '' }, { name: 'yep', tier: 'achieved', note: '' }] as never, bands: [{ id: 'b0', lowerInclusive: 0, upper: 1, upperInclusive: true, thresholdOutcome: 'nope', sampleWeights: { nope: 0.5, yep: 0.5 } }] };
  const eff = effectiveProfile(settings);
  assert.deepEqual(eff.warnings, []);
  assert.deepEqual(eff.profile.outcomes.map(o => [o.name, o.records, o.final]), [['nope', '', false], ['yep', 'achieved', true]]);
});

test('a saved table override is validated as a whole: columns and rows together', () => {
  const settings = defaultSettings();
  const t = custom();
  settings.profileOverrides.binding = { outcomes: t.outcomes, bands: t.bands };
  const ok = effectiveProfile(settings);
  assert.deepEqual(ok.warnings, []);
  assert.deepEqual(ok.profile.outcomes.map(o => o.name), ['shut_out', 'not_yet', 'foot_in_door', 'yes']);
  assert.notEqual(ok.profile.revision, 'example-3.0.0');
  settings.profileOverrides.binding = { outcomes: t.outcomes.slice(0, 3), bands: t.bands };
  const bad = effectiveProfile(settings);
  assert.ok(bad.warnings.length > 0);
  assert.deepEqual(bad.profile.outcomes, DEFAULT_OUTCOMES, 'a broken override falls back to the built-in table, never half of each');
  assert.deepEqual(bad.profile.bands, DEFAULT_BANDS);
});

test('W6: completing a custom outcome stores its frozen ruling without recording a settled gain', async () => {
  const { newRecord, applyEvent } = await import('../../src/state.ts');
  const t = custom();
  const action = gateAction_('passage now');
  const low = resolveOutcome({ bands: t.bands, outcomes: t.outcomes, method: 'threshold', signal: { x: 0.05, primitive: 'noul', levels: null }, draw: null });
  assert.ok(low.ok);
  const res = freeze({ resolutionId: 'r1', previousResolutionId: null, action, snapshot, assessment: null, decisionSource: 'provider', policyRevision: 'r', band: low.value.band, method: 'threshold', draw: null, outcome: low.value.outcome, def: low.value.def, cursorBefore: null, generation: 1, providerKind: 'mock', requestedModel: null, returnedModel: null, now: 1 });
  let record = newRecord('seed', 'r');
  for (const event of [
    { type: 'prepare', resolution: res, action, attemptId: 'a1', actorId: 'oren', epoch: 1, composerText: '', now: 1 },
    { type: 'bind', attemptId: 'a1', cursorBefore: 'c0', epoch: 1, injectedText: 'block' },
    { type: 'completed', attemptId: 'a1', epoch: 1, operationId: 'op', variantId: 'v1', hostMessageRef: 1, hostVariantRef: 0, cursorAfter: 'c1', now: 2 },
  ] as const) record = applyEvent(record, event).record;
  assert.equal(record.resolutions.r1!.outcome, 'shut_out');
  assert.equal(record.resolutions.r1!.status, 'accepted');
  assert.equal('projection' in record, false);
  assert.equal('checkpoints' in record, false);
});
