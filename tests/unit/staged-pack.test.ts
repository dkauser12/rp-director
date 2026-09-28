import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORE_PROTECTED, DEFAULT_PACK, protectedLines, validatePack } from '../../src/pack/pack.ts';
import type { GenrePack } from '../../src/pack/pack.ts';

const clone = (): GenrePack => structuredClone(DEFAULT_PACK);

test('the default pack is valid and carries the seven attempt families', () => {
  assert.deepEqual(validatePack(DEFAULT_PACK).errors, []);
  assert.deepEqual(DEFAULT_PACK.families.map(f => f.key), ['overcome_operate', 'contest_impose', 'evade_resist', 'conceal_deceive', 'detect_discover', 'influence_negotiate', 'acquire_secure']);
  assert.equal(DEFAULT_PACK.families.find(f => f.key === 'detect_discover')!.kind, 'discovery');
});

test('a discovery family may not read character cards', () => {
  const pack = clone();
  pack.families.find(f => f.key === 'detect_discover')!.evidence.push('target_card');
  const result = validatePack(pack);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /detect_discover.*discovery.*target_card/);
});

test('family keys must be unique, well-formed and not reserved', () => {
  const pack = clone();
  pack.families.push({ ...structuredClone(pack.families[0]!) });
  pack.families.push({ ...structuredClone(pack.families[0]!), key: 'UNSUPPORTED' });
  pack.families.push({ ...structuredClone(pack.families[0]!), key: 'Bad Key' });
  const errors = validatePack(pack).errors.join(' ');
  assert.match(errors, /duplicate family overcome_operate/);
  assert.match(errors, /reserved/);
  assert.match(errors, /Bad Key/);
});

test('evidence sources are a closed list and always include the transcript', () => {
  const pack = clone();
  (pack.families[0]!.evidence as string[]).push('everything');
  pack.families[1]!.evidence = ['owner_card'];
  const errors = validatePack(pack).errors.join(' ');
  assert.match(errors, /unknown evidence source everything/);
  assert.match(errors, /contest_impose.*transcript/);
});

test('the player must be a rulable owner and the gate must say what counts', () => {
  const pack = clone();
  pack.actors.rulableOwners = ['npc'];
  pack.gate.include = [];
  const errors = validatePack(pack).errors.join(' ');
  assert.match(errors, /rulableOwners must include player/);
  assert.match(errors, /gate\.include/);
});

test('core protections are always applied and a pack can only add to them', () => {
  const pack = clone();
  pack.protected = [];
  assert.deepEqual(protectedLines(pack), [...CORE_PROTECTED]);
  pack.protected = ['A faction\'s loyalty.'];
  assert.deepEqual(protectedLines(pack), [...CORE_PROTECTED, 'A faction\'s loyalty.']);
});
