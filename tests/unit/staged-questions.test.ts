import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countQuestion, moveQuestion, routeQuestions, rulingQuestion } from '../../src/pipeline/questions.ts';
import { deriveRoute } from '../../src/pipeline/route.ts';
import { candidateSpans } from '../../src/pipeline/spans.ts';
import { CORE_PROTECTED, DEFAULT_PACK, familyByKey } from '../../src/pack/pack.ts';
import type { GenrePack } from '../../src/pack/pack.ts';
import { checkBatch } from '../../src/questions.ts';

const sentinelPack = (): GenrePack => ({
  ...structuredClone(DEFAULT_PACK),
  id: 'sentinel',
  gate: { include: ['SENTINEL-INCLUDE criterion.'], exclude: ['SENTINEL-EXCLUDE criterion.'] },
  protected: ['SENTINEL-PROTECTED line.'],
  families: [{ key: 'sentinel_family', label: 'Sentinel', kind: 'change', evidence: ['transcript'], definition: 'SENTINEL-DEFINITION.', successSemantics: 'SENTINEL-SUCCESS.' }],
});

const actors = { player: 'Jordan', 'isla-1': 'Isla', 'wren-2': 'Wren' };

test('stage A offers the verbatim passages plus NONE and takes its criteria only from the pack', () => {
  const spans = candidateSpans('I sit. "Go ahead, make me."');
  const q = moveQuestion(spans, sentinelPack());
  assert.equal(q.type, 'choice');
  assert.deepEqual(Object.keys(q.criteria), ['s1', 's2', 'p1', 'all', 'ROUTINE', 'NONE']);
  assert.equal(q.criteria.s2, '"Go ahead, make me."');
  assert.ok('NONE' in q.criteria);
  assert.match(q.instructions, /SENTINEL-INCLUDE/);
  assert.match(q.instructions, /SENTINEL-EXCLUDE/);
  assert.doesNotMatch(q.instructions, /hidden fact/, 'no default-pack genre wording leaks into the builder');
  assert.equal(countQuestion(sentinelPack()).type, 'choice');
  assert.match(countQuestion(sentinelPack()).instructions, /SENTINEL-INCLUDE/);
});

test('stage B asks five independent routing questions with bounded options', () => {
  const qs = routeQuestions({ actorNames: actors, playerId: 'player', pack: sentinelPack(), antecedents: [{ id: 'a1', text: 'Say it out loud.' }, { id: 'a2', text: 'Your move, cousin.' }] });
  assert.deepEqual(Object.keys(qs), ['owner', 'target', 'family', 'action_specification', 'antecedent']);
  assert.deepEqual(Object.keys(qs.owner!.criteria), ['player', 'isla-1', 'wren-2', 'UNRESOLVED']);
  assert.deepEqual(Object.keys(qs.target!.criteria), ['player', 'isla-1', 'wren-2', 'SELF', 'SEVERAL', 'SCENE', 'UNRESOLVED']);
  assert.deepEqual(Object.keys(qs.family!.criteria), ['sentinel_family', 'UNSUPPORTED']);
  assert.match(String((qs.family!.criteria as Record<string, string>).sentinel_family), /SENTINEL-DEFINITION/);
  assert.deepEqual(Object.keys(qs.action_specification!.criteria), ['SPECIFIED_HERE', 'SPECIFIED_BY_PUBLIC_REFERENCE', 'UNSPECIFIED_INITIATIVE', 'UNRESOLVED']);
  assert.deepEqual(Object.keys(qs.antecedent!.criteria), ['a1', 'a2', 'NONE', 'UNRESOLVED']);
  assert.match(qs.owner!.instructions, /invites|orders|hands/i);
  assert.deepEqual(checkBatch(qs, 16, Object.keys(qs).map(() => 'shared-public')).errors, []);
});

test('stage E rules on the family\'s own success meaning with the core protections', () => {
  const pack = sentinelPack();
  const q = rulingQuestion({ family: familyByKey(pack, 'sentinel_family')!, pack, hasAntecedent: true });
  assert.equal(q.type, 'noul');
  assert.match(q.instructions, /SENTINEL-SUCCESS/);
  assert.match(q.instructions, /SENTINEL-PROTECTED/);
  for (const line of CORE_PROTECTED) assert.ok(q.instructions.includes(line), line);
  assert.match(q.instructions, /state\.move\.passage/);
  assert.match(q.instructions, /state\.move\.antecedent/);
  assert.doesNotMatch(rulingQuestion({ family: familyByKey(pack, 'sentinel_family')!, pack, hasAntecedent: false }).instructions, /state\.move\.antecedent/);
});

const npcIds = ['isla-1', 'wren-2'];
const route = (owner: string, target: string, family: string, spec: string, antecedent = 'NONE') =>
  deriveRoute({ owner, target, family, specification: spec, antecedent }, { playerId: 'player', npcIds, pack: DEFAULT_PACK });

test('the player\'s own attempt is a direct attempt', () => {
  const r = route('player', 'isla-1', 'influence_negotiate', 'SPECIFIED_HERE');
  assert.equal(r.route, 'DIRECT_ATTEMPT');
  assert.equal(r.ownerId, 'player');
  assert.equal(r.targetId, 'isla-1');
});

test('an order to an NPC is ruled with the NPC as owner', () => {
  const r = route('wren-2', 'SCENE', 'overcome_operate', 'SPECIFIED_HERE');
  assert.equal(r.route, 'SPECIFIED_NPC_MOVE');
  assert.equal(r.ownerId, 'wren-2');
});

test('"go ahead, make me" is a hand-off, whatever the family answer', () => {
  assert.equal(route('isla-1', 'player', 'UNSUPPORTED', 'UNSPECIFIED_INITIATIVE').route, 'HANDOFF');
  assert.equal(route('isla-1', 'player', 'influence_negotiate', 'UNSPECIFIED_INITIATIVE').ownerId, 'isla-1');
});

test('anything unresolved is explicitly unruled, never a default ruling', () => {
  assert.equal(route('UNRESOLVED', 'isla-1', 'influence_negotiate', 'SPECIFIED_HERE').route, 'UNRULED');
  assert.equal(route('player', 'isla-1', 'UNSUPPORTED', 'SPECIFIED_HERE').route, 'UNRULED');
  assert.equal(route('player', 'isla-1', 'influence_negotiate', 'UNRESOLVED').route, 'UNRULED');
  assert.equal(route('stranger', 'isla-1', 'influence_negotiate', 'SPECIFIED_HERE').route, 'UNRULED');
  const missing = deriveRoute({ owner: null, target: 'isla-1', family: 'influence_negotiate', specification: 'SPECIFIED_HERE', antecedent: 'NONE' }, { playerId: 'player', npcIds, pack: DEFAULT_PACK });
  assert.equal(missing.route, 'UNRULED');
  assert.match(missing.reason, /owner/);
});

test('a reference to earlier terms needs the earlier passage', () => {
  assert.equal(route('player', 'isla-1', 'influence_negotiate', 'SPECIFIED_BY_PUBLIC_REFERENCE', 'UNRESOLVED').route, 'UNRULED');
  const r = route('player', 'isla-1', 'influence_negotiate', 'SPECIFIED_BY_PUBLIC_REFERENCE', 'a3');
  assert.equal(r.route, 'DIRECT_ATTEMPT');
  assert.equal(r.antecedentId, 'a3');
});

test('packs that do not let NPCs own rulings leave NPC orders unruled', () => {
  const pack = { ...structuredClone(DEFAULT_PACK), actors: { kinds: ['player', 'npc'] as ('player' | 'npc')[], rulableOwners: ['player'] as ('player' | 'npc')[] } };
  assert.equal(deriveRoute({ owner: 'wren-2', target: 'SCENE', family: 'overcome_operate', specification: 'SPECIFIED_HERE', antecedent: 'NONE' }, { playerId: 'player', npcIds, pack }).route, 'UNRULED');
});

test('for a request the asker owns the move; a character owns it only when given a task or the initiative', () => {
  const qs = routeQuestions({ actorNames: actors, playerId: 'player', pack: DEFAULT_PACK, antecedents: [] });
  assert.match(qs.owner!.instructions, /asking|asks/i);
  assert.match(qs.owner!.instructions, /task/i);
  assert.match(countQuestion(DEFAULT_PACK).instructions, /steps/i, 'steps toward one goal are one move');
});

test('an unresolved or plural target still rules the move, without a single target', () => {
  const unresolved = route('player', 'UNRESOLVED', 'overcome_operate', 'SPECIFIED_HERE');
  assert.equal(unresolved.route, 'DIRECT_ATTEMPT');
  assert.equal(unresolved.targetId, null);
  const several = route('player', 'SEVERAL', 'overcome_operate', 'SPECIFIED_HERE');
  assert.equal(several.route, 'DIRECT_ATTEMPT');
  assert.equal(several.targetId, 'SEVERAL');
});

test('a hand-off goes to the character receiving the initiative, even when the judge names the player as owner', () => {
  const r = route('player', 'isla-1', 'influence_negotiate', 'UNSPECIFIED_INITIATIVE');
  assert.equal(r.route, 'HANDOFF');
  assert.equal(r.ownerId, 'isla-1');
  assert.equal(route('player', 'SCENE', 'influence_negotiate', 'UNSPECIFIED_INITIATIVE').route, 'UNRULED', 'no character to receive it');
});

test('the earlier passage counts only when the move points back to it', () => {
  assert.equal(route('player', 'isla-1', 'influence_negotiate', 'SPECIFIED_HERE', 'a2').antecedentId, null);
  assert.equal(route('player', 'isla-1', 'influence_negotiate', 'SPECIFIED_BY_PUBLIC_REFERENCE', 'a2').antecedentId, 'a2');
});

test('the default gate excludes moves that are routine or certain for whoever performs them', () => {
  assert.match(DEFAULT_PACK.gate.exclude.join(' '), /routine or (effectively )?certain for/i);
});
