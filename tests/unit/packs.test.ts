import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_PACKS, listPacks, packById, registerLocalPacks } from '../../src/pack/packs.ts';
import { DEFAULT_PACK, PRIVATE_SOURCES, validatePack } from '../../src/pack/pack.ts';
import type { GenrePack } from '../../src/pack/pack.ts';

test('five built-in packs, each valid, each with at least one meter', () => {
  assert.deepEqual(BUILT_IN_PACKS.map(p => p.id), ['default', 'romance', 'adventure', 'investigation', 'politics']);
  for (const pack of BUILT_IN_PACKS) {
    assert.deepEqual(validatePack(pack).errors, [], pack.id);
    assert.ok(pack.meters.length >= 1, `${pack.id} has meters`);
    assert.ok(pack.description.length > 20, `${pack.id} explains itself`);
    assert.ok(pack.families.some(f => f.kind === 'discovery'), `${pack.id} has a discovery family`);
  }
  assert.equal(packById('default'), DEFAULT_PACK);
});

test('discovery families never read cards or meters in any built-in pack', () => {
  for (const pack of BUILT_IN_PACKS) {
    for (const family of pack.families.filter(f => f.kind === 'discovery')) {
      for (const source of family.evidence) assert.ok(!PRIVATE_SOURCES.includes(source), `${pack.id}.${family.key} reads ${source}`);
    }
  }
});

test('meters are plain-language scales with a valid starting level', () => {
  const pack: GenrePack = structuredClone(BUILT_IN_PACKS[1]!);
  pack.meters[0]!.levels = ['only', 'two'];
  pack.meters[1]!.initial = 9;
  const errors = validatePack(pack).errors.join(' ');
  assert.match(errors, /3 to 7 levels/);
  assert.match(errors, /initial/);
  const discoveryReadsMeters = structuredClone(DEFAULT_PACK);
  discoveryReadsMeters.families.find(f => f.kind === 'discovery')!.evidence.push('meters');
  assert.match(validatePack(discoveryReadsMeters).errors.join(' '), /discovery family may not read meters/);
});

test('unknown pack ids fall back to the default pack', () => {
  assert.equal(packById('nope').id, 'default');
});

test('local packs register after validation; duplicates and invalid packs are refused', () => {
  const custom = { ...structuredClone(BUILT_IN_PACKS[2]!), id: 'grimdark', label: 'Grimdark', description: 'A local test pack with the adventure families.' };
  const result = registerLocalPacks({ schemaVersion: 1, packs: [custom, { ...custom }, { ...custom, id: 'broken', families: [] }] });
  assert.deepEqual(result.loaded, ['grimdark']);
  assert.equal(result.warnings.length, 2);
  assert.ok(listPacks().some(p => p.id === 'grimdark'));
  assert.equal(packById('grimdark').label, 'Grimdark');
});
