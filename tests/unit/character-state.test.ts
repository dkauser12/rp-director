import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyStory, knownByAt, levelsAt, normalizeStory, snapshotAt, withSnapshot } from '../../src/story.ts';
import { applyStateAnswers, meterFacts, stateBlock, stateEvidence, stateQuestions } from '../../src/pipeline/character-state.ts';
import { packById } from '../../src/pack/packs.ts';
import { checkBatch } from '../../src/questions.ts';
import type { Answer } from '../../src/types.ts';

const romance = packById('romance');
const choice = (value: string): Answer => ({ type: 'choice', choice: value, probabilities: null, confidence: null, provenance: 'fixture' } as Answer);

test('a new chat has no pack chosen yet, no secrets and no history', () => {
  assert.deepEqual(emptyStory(), { packId: 'auto', packSource: 'auto', secrets: [], history: {}, lore: {} });
  assert.deepEqual(normalizeStory(null), emptyStory());
  assert.deepEqual(normalizeStory({ packId: 'romance', packSource: 'user', secrets: [{ id: 's1', text: 'x', holders: ['isla'] }, { bad: true }], history: 'nope' }).secrets, [{ id: 's1', text: 'x', holders: ['isla'] }]);
});

test('state follows the transcript: the nearest earlier snapshot on this branch wins', () => {
  let story = emptyStory();
  story = withSnapshot(story, 'c2', { at: 2, meters: { isla: { regard: 3 } }, knownBy: {} });
  story = withSnapshot(story, 'c4', { at: 4, meters: { isla: { regard: 4 } }, knownBy: {} });
  assert.equal(snapshotAt(story, ['c1', 'c2', 'c3'])?.meters.isla?.regard, 3, 'after c2, before c4');
  assert.equal(snapshotAt(story, ['c1', 'c2', 'c3', 'c4', 'c5'])?.meters.isla?.regard, 4);
  assert.equal(snapshotAt(story, ['c1', 'c2', 'x3', 'x4'])?.meters.isla?.regard, 3, 'a different branch after c2 keeps c2');
  assert.equal(snapshotAt(story, ['c1']), null);
});

test('unassessed characters start at each meter\'s initial level; holders know their own secrets', () => {
  const story = { ...emptyStory(), secrets: [{ id: 's1', text: 'Isla reads his texts.', holders: ['isla'] }] };
  const { levels, assessed } = levelsAt(story, ['c1'], romance, ['isla']);
  assert.deepEqual(levels, { isla: { regard: 2, nerve: 2 } });
  assert.deepEqual(assessed, { isla: { regard: false, nerve: false } });
  assert.deepEqual(knownByAt(story, ['c1']), { s1: ['isla'] });
});

const npcs = [{ id: 'isla', name: 'Isla' }];

test('a first assessment may pick any level; later ones move at most one level', () => {
  const first = stateQuestions({ pack: romance, npcs, levels: { isla: { regard: 2, nerve: 2 } }, assessed: { isla: false }, playerName: 'Jordan', secrets: [], knownBy: {}, actorNames: { player: 'Jordan', isla: 'Isla' }, maxQuestions: 16 });
  assert.deepEqual(Object.keys(first.questions.meter_1_regard!.criteria), ['cold', 'guarded', 'friendly', 'warm', 'smitten']);
  const later = stateQuestions({ pack: romance, npcs, levels: { isla: { regard: 3, nerve: 0 } }, assessed: { isla: true }, playerName: 'Jordan', secrets: [], knownBy: {}, actorNames: { player: 'Jordan', isla: 'Isla' }, maxQuestions: 16 });
  assert.deepEqual(Object.keys(later.questions.meter_1_regard!.criteria), ['friendly', 'warm', 'smitten']);
  assert.deepEqual(Object.keys(later.questions.meter_1_nerve!.criteria), ['withdrawn', 'hesitant']);
  assert.match(later.questions.meter_1_regard!.instructions, /warm/);
  assert.match(later.questions.meter_1_regard!.instructions, /Keep the previous level unless/);
  assert.deepEqual(checkBatch(later.questions, 16, Object.keys(later.questions).map(() => 'private')).errors, []);
});

test('answers apply within the bound; missing or out-of-range answers keep the previous level', () => {
  const built = stateQuestions({ pack: romance, npcs, levels: { isla: { regard: 3, nerve: 2 } }, assessed: { isla: true }, playerName: 'Jordan', secrets: [], knownBy: {}, actorNames: { player: 'Jordan', isla: 'Isla' }, maxQuestions: 16 });
  const applied = applyStateAnswers(built.index, { meter_1_regard: choice('smitten'), meter_1_nerve: choice('relentless') }, { isla: { regard: 3, nerve: 2 } }, {});
  assert.deepEqual(applied.meters, { isla: { regard: 4, nerve: 2 } });
  assert.deepEqual(applied.changes, ['Isla: regard warm → smitten']);
});

test('reveals: who newly learned a secret is judged per secret and recorded', () => {
  const secrets = [{ id: 's1', text: 'Isla reads his texts.', holders: ['isla'] }];
  const built = stateQuestions({ pack: romance, npcs: [...npcs, { id: 'wren', name: 'Wren' }], levels: { isla: { regard: 2, nerve: 2 }, wren: { regard: 2, nerve: 2 } }, assessed: { isla: true, wren: true }, playerName: 'Jordan', secrets, knownBy: { s1: ['isla'] }, actorNames: { player: 'Jordan', isla: 'Isla', wren: 'Wren' }, maxQuestions: 16 });
  assert.deepEqual(Object.keys(built.questions.reveal_1!.criteria), ['KEEP', 'player', 'wren', 'EVERYONE']);
  const applied = applyStateAnswers(built.index, { reveal_1: choice('player') }, {}, { s1: ['isla'] });
  assert.deepEqual(applied.knownBy, { s1: ['isla', 'player'] });
  const everyone = applyStateAnswers(built.index, { reveal_1: choice('EVERYONE') }, {}, { s1: ['isla'] });
  assert.deepEqual(everyone.knownBy.s1!.sort(), ['isla', 'player', 'wren']);
});

test('the evidence carries cards and secrets for the state request only', () => {
  const state = stateEvidence({ transcript: [{ actorId: 'isla', role: 'assistant', text: 'She smiles.<details>hidden</details>' }], latestInput: 'Hi.', characters: [{ id: 'isla', name: 'Isla', card: 'x'.repeat(5000) }], secrets: [{ id: 's1', text: 'Isla reads his texts.', holders: ['isla'] }], playerName: 'Jordan', maxChars: 60000 });
  const json = JSON.stringify(state);
  assert.ok(!json.includes('hidden'));
  assert.ok(json.includes('Isla reads his texts.'));
  assert.ok((state as { characters: Record<string, { card: string }> }).characters.isla!.card.length <= 3001, 'cards are trimmed');
});

test('state and pack evidence remove collapsed details before card clipping and from the latest input and secrets', () => {
  const hidden = `<details><summary>Private</summary>STATE-HIDDEN-CANARY ${'x'.repeat(4000)}</details>`;
  const state = stateEvidence({
    transcript: [], latestInput: `Hello. ${hidden}`,
    characters: [{ id: 'npc', name: 'Character', card: `Visible trait. ${hidden} Another visible trait.` }],
    secrets: [{ id: 'secret', text: `Visible secret text. ${hidden}`, holders: ['npc'] }],
    playerName: 'Player', maxChars: 60000,
  });
  const json = JSON.stringify(state);
  assert.doesNotMatch(json, /STATE-HIDDEN-CANARY/);
  assert.match(json, /Another visible trait/);
  assert.match(json, /Visible secret text/);
  assert.match(json, /Hello/);
});

test('the writer block states levels and knowledge boundaries plainly; the judge gets meters as facts', () => {
  const block = stateBlock({ pack: romance, levels: { isla: { regard: 3, nerve: 4 } }, names: { isla: 'Isla', wren: 'Wren', player: 'Jordan' }, playerName: 'Jordan', secrets: [{ id: 's1', text: 'Isla reads his texts.', holders: ['isla'] }], knownBy: { s1: ['isla'] }, meters: true, secretsOn: true });
  assert.match(block, /Isla: regard for Jordan warm \(4 of 5\); nerve relentless \(5 of 5\)/);
  assert.match(block, /Known only to Isla: Isla reads his texts\./);
  assert.equal(stateBlock({ pack: romance, levels: {}, names: {}, playerName: 'Jordan', secrets: [], knownBy: {}, meters: true, secretsOn: true }), '');
  assert.deepEqual(meterFacts(romance, { isla: { regard: 3, nerve: 4 } }, 'Jordan'), { isla: { 'regard for Jordan': 'warm (4 of 5)', nerve: 'relentless (5 of 5)' } });
});

test('the pack pick offers every pack with its description, once per chat', async () => {
  const { packQuestion } = await import('../../src/pipeline/pack-pick.ts');
  const { listPacks } = await import('../../src/pack/packs.ts');
  const q = packQuestion(listPacks());
  assert.equal(q.type, 'choice');
  assert.deepEqual(Object.keys(q.criteria), listPacks().map(p => p.id));
  assert.match(q.criteria.romance!, /Romance/);
  assert.match(q.instructions, /state\.characters/);
});

test('rulings on change moves see the involved characters\' meters; discovery never does', async () => {
  const { judgeProjection } = await import('../../src/pipeline/evidence.ts');
  const { familyByKey } = await import('../../src/pack/pack.ts');
  const base = {
    pack: romance, playerId: 'player', ownerId: 'player', targetId: 'isla',
    actors: { player: { name: 'Jordan', control: 'user' as const }, isla: { name: 'Isla', control: 'npc' as const, card: 'card' }, wren: { name: 'Wren', control: 'npc' as const } },
    transcript: [], latestInput: 'x', facts: {}, move: { passage: 'x', antecedent: null }, maxChars: 60000,
    meters: { isla: { 'regard for Jordan': 'warm (4 of 5)' }, wren: { 'regard for Jordan': 'cold (1 of 5)' } },
  };
  const ask = JSON.stringify(judgeProjection({ ...base, family: familyByKey(romance, 'ask')! }).state);
  assert.match(ask, /warm \(4 of 5\)/);
  assert.doesNotMatch(ask, /cold \(1 of 5\)/, 'only the characters involved in the move');
  const read = JSON.stringify(judgeProjection({ ...base, family: familyByKey(romance, 'read')! }).state);
  assert.doesNotMatch(read, /of 5/);
});
