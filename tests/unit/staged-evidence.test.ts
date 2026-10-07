import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeProjection } from '../../src/pipeline/evidence.ts';
import type { EvidenceInput } from '../../src/pipeline/evidence.ts';
import { DEFAULT_PACK, familyByKey } from '../../src/pack/pack.ts';

const CARD_CANARY = 'CANARY-CARD-7f3a';
const THOUGHT_CANARY = 'CANARY-THOUGHT-19c2';

function input(familyKey: string, overrides: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    pack: DEFAULT_PACK,
    family: familyByKey(DEFAULT_PACK, familyKey)!,
    playerId: 'player',
    ownerId: 'player',
    targetId: 'juno-1',
    actors: {
      player: { name: 'Hale', control: 'user' },
      'juno-1': { name: 'Juno', control: 'npc', card: `Juno is a diviner. Private: she already knows Hale's real identity (${CARD_CANARY}).` },
      'kestrel-2': { name: 'Kestrel', control: 'npc', card: 'Kestrel is a pilot.' },
    },
    transcript: [
      { actorId: 'juno-1', role: 'assistant', text: `Juno pauses.<details><summary>Thoughts</summary>${THOUGHT_CANARY}: she recognised him.</details> "Hm."` },
      { actorId: 'player', role: 'user', text: 'I study her reaction.' },
    ],
    latestInput: 'I study her reaction to see whether she recognised me.',
    move: { passage: 'I study her reaction to see whether she recognised me.', antecedent: null },
    maxChars: 60000,
    ...overrides,
  };
}

test('detection canary: no card and no collapsed thought reaches a discovery ruling', () => {
  const projection = judgeProjection(input('detect_discover'));
  const serialized = JSON.stringify(projection.state);
  assert.ok(!serialized.includes(CARD_CANARY), 'authorial card truth stays out');
  assert.ok(!serialized.includes('diviner'), 'no card text at all');
  assert.ok(!serialized.includes(THOUGHT_CANARY), 'collapsed private thoughts stay out');
  assert.match(serialized, /Juno pauses/);
  assert.ok(projection.exclusions.some(line => /card/i.test(line)));
});

test('a change family may read the target\'s card, but never collapsed thoughts', () => {
  const projection = judgeProjection(input('influence_negotiate'));
  const serialized = JSON.stringify(projection.state);
  assert.ok(serialized.includes(CARD_CANARY), 'influence reads the target card');
  assert.ok(!serialized.includes(THOUGHT_CANARY));
  assert.ok(!serialized.includes('Kestrel is a pilot'), 'uninvolved characters\' cards stay out');
});

test('discovery stays card-free even if a pack wrongly lists a card source', () => {
  const family = { ...familyByKey(DEFAULT_PACK, 'detect_discover')!, evidence: ['transcript', 'target_card'] as ('transcript' | 'target_card')[] };
  const serialized = JSON.stringify(judgeProjection({ ...input('detect_discover'), family }).state);
  assert.ok(!serialized.includes(CARD_CANARY));
});

test('the owner\'s card is read only when the family allows it and the owner is an NPC', () => {
  const npcOwned = judgeProjection({ ...input('overcome_operate'), ownerId: 'kestrel-2', targetId: 'SCENE' });
  assert.match(JSON.stringify(npcOwned.state), /Kestrel is a pilot/);
  const playerOwned = judgeProjection({ ...input('overcome_operate'), targetId: 'SCENE' });
  assert.doesNotMatch(JSON.stringify(playerOwned.state), /Kestrel is a pilot|diviner/);
});

test('the move is named in the state and oldest messages are trimmed first', () => {
  const long = Array.from({ length: 12 }, (_, i) => ({ actorId: 'juno-1', role: 'assistant' as const, text: `Old message ${i} ` + 'x'.repeat(900) }));
  const projection = judgeProjection({ ...input('influence_negotiate'), transcript: long, maxChars: 6000 });
  const state = projection.state as { move: { passage: string; owner: { id: string } ; target: { id: string } }; recentAcceptedMessages: { text: string }[] };
  assert.equal(state.move.passage, 'I study her reaction to see whether she recognised me.');
  assert.equal(state.move.owner.id, 'player');
  assert.equal(state.move.target.id, 'juno-1');
  assert.ok(state.recentAcceptedMessages.length < 12);
  assert.match(state.recentAcceptedMessages.at(-1)!.text, /Old message 11/);
  assert.ok(projection.chars <= 6000 || projection.overBudget);
});

test('old tracked facts never reach the ruling after removal of the observer', () => {
  assert.doesNotMatch(JSON.stringify(judgeProjection(input('influence_negotiate')).state), /locked|"facts"/);
});

const LORE_CANARY = 'CANARY-LORE-5b1e';
const lore = [
  { book: 'Juno (private)', title: 'Divination', text: `Juno reads the recent past of anyone she touches (${LORE_CANARY}).`, public: false },
  { book: 'Skyreach', title: 'Gray Harbor', text: 'Gray Harbor is the old dock district.', public: true },
];

test('lore canary: private lore never reaches a discovery ruling; public lore does', () => {
  const projection = judgeProjection(input('detect_discover', { lore }));
  const serialized = JSON.stringify(projection.state);
  assert.ok(!serialized.includes(LORE_CANARY), 'private lore stays out of discovery');
  assert.ok(!serialized.includes('Divination'), 'not even its title');
  assert.match(serialized, /Gray Harbor is the old dock district/);
  assert.ok(projection.exclusions.some(e => /1 private lore entry withheld/.test(e)));
});

test('change families read private and public lore, most relevant first', () => {
  const projection = judgeProjection(input('influence_negotiate', { lore }));
  const state = projection.state as { lore?: { title: string }[] };
  assert.deepEqual(state.lore?.map(l => l.title), ['Divination', 'Gray Harbor']);
});

test('lore respects its own budget and long entries are clipped', () => {
  const long = [{ book: 'B', title: 'Long', text: 'x'.repeat(5000), public: true }, { book: 'B', title: 'Next', text: 'y'.repeat(2000), public: true }];
  const projection = judgeProjection(input('influence_negotiate', { lore: long, maxLoreChars: 4000 }));
  const state = projection.state as { lore?: { title: string; text: string }[] };
  assert.equal(state.lore?.length, 1);
  assert.equal(state.lore?.[0]!.text.length, 3000);
  assert.ok(projection.exclusions.some(e => /1 lore entry dropped/.test(e)));
});

test('a family that does not list lore gets none', () => {
  const noLore = { ...familyByKey(DEFAULT_PACK, 'influence_negotiate')!, evidence: ['transcript' as const] };
  const projection = judgeProjection(input('influence_negotiate', { lore, family: noLore }));
  assert.equal((projection.state as { lore?: unknown }).lore, undefined);
});

test('lore never takes more than 40% of the ruling\'s budget, so recent messages survive', () => {
  const big = Array.from({ length: 12 }, (_, i) => ({ book: 'B', title: 'T' + i, text: 'z'.repeat(2900), public: true }));
  const projection = judgeProjection(input('influence_negotiate', { lore: big, maxLoreChars: 40000, maxChars: 20000 }));
  const state = projection.state as { lore?: { text: string }[]; recentAcceptedMessages?: unknown[] };
  const loreChars = (state.lore ?? []).reduce((sum, item) => sum + item.text.length, 0);
  assert.ok(loreChars <= 8000, String(loreChars));
  assert.equal(state.recentAcceptedMessages?.length, 2);
});

test('collapsed details are excluded from every allowed source, including the current input and authorial cards', () => {
  const hidden = '<details><summary>Private</summary>HIDDEN-SOURCE-CANARY</details>';
  const projection = judgeProjection(input('influence_negotiate', {
    actors: { player: { name: 'Player', control: 'user' }, 'juno-1': { name: 'Character', control: 'npc', card: `Visible trait. ${hidden}` } },
    latestInput: `I ask her to stay. ${hidden}`,
    move: { passage: `I ask her to stay. ${hidden}`, antecedent: `She offered to leave. ${hidden}` },
    meters: { 'juno-1': { regard: `warm ${hidden}` } },
    lore: [{ book: 'Book', title: 'Title', text: `Visible lore. ${hidden}`, public: true }],
  }));
  const serialized = JSON.stringify(projection.state);
  assert.doesNotMatch(serialized, /HIDDEN-SOURCE-CANARY/);
  for (const visible of ['Visible trait', 'I ask her to stay', 'She offered to leave', 'warm', 'Visible lore']) assert.ok(serialized.includes(visible));
  assert.doesNotMatch(serialized, /Visible fact/);
});

test('discovery never receives meters or private lore even when its pack permits those sources', () => {
  const family = { ...familyByKey(DEFAULT_PACK, 'detect_discover')!, evidence: ['transcript', 'target_card', 'meters', 'lore'] as const };
  const projection = judgeProjection(input('detect_discover', {
    family: { ...family, evidence: [...family.evidence] },
    meters: { 'juno-1': { regard: 'METER-HIDDEN-CANARY' } },
    lore: [{ book: 'Hidden', title: 'Secret', text: 'PRIVATE-HIDDEN-CANARY', public: false }],
  }));
  assert.doesNotMatch(JSON.stringify(projection.state), /METER-HIDDEN-CANARY|PRIVATE-HIDDEN-CANARY|CANARY-CARD/);
});
