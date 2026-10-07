import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, entriesUnder, DEFAULT_TREE_OPTIONS } from '../../src/lore/tree.ts';

/** Keep an index even for tiny test books (the default offers books of up to 40 entries flat). */
const INDEXED = { ...DEFAULT_TREE_OPTIONS, flatLimit: 0 };
import type { LoreEntry, LoreNode } from '../../src/lore/tree.ts';
import { beamPicks, selectLore, frontierQuestion } from '../../src/lore/select.ts';
import type { Answer, EvaluationResult, Question } from '../../src/types.ts';

function entry(uid: number, title: string, extra: Partial<LoreEntry> = {}): LoreEntry {
  return { world: 'Book', uid, title, keys: [title.toLowerCase()], content: `${title} content.`, constant: false, disabled: false, ...extra };
}

function choice(probabilities: Record<string, number>): Answer {
  const choiceKey = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
  return { type: 'choice', choice: choiceKey, probabilities, provenance: 'native', confidence: null };
}

function result(answers: Record<string, Answer>): EvaluationResult {
  return { requestId: 'r', provider: 'mock', requestedModel: null, returnedModel: null, answers, unresolvedQuestionIds: [], errors: {}, inputTokens: null, outputTokens: null, durationMs: 1, transportAttempts: 1 };
}

const maxWidth = (node: LoreNode): number => Math.max(node.children.length, ...node.children.map(maxWidth));

test('derived tree: one leaf per selectable entry; constants, disabled and empty entries are left out', () => {
  const tree = buildTree('Book', [
    entry(0, 'Dock'), entry(1, 'Always on', { constant: true }), entry(2, 'Off', { disabled: true }), entry(3, 'Empty', { content: '  ' }), entry(4, 'Casino'),
  ], null)!;
  assert.equal(tree.source, 'derived');
  assert.deepEqual(tree.root.children.map(c => c.label), ['Dock', 'Casino']);
  assert.deepEqual(entriesUnder(tree.root), [0, 4]);
});

test('a book with no selectable entry has no tree', () => {
  assert.equal(buildTree('Book', [entry(0, 'X', { constant: true })], null), null);
  assert.equal(buildTree('Other', [entry(0, 'X')], null), null, 'entries of another book are ignored');
});

test('TunnelVision tree: sections keep their labels, stale uids drop, unindexed entries stay reachable', () => {
  const tv = {
    label: 'Root', entryUids: [], children: [
      { id: 'a', label: 'Places', summary: 'Where things are.\n[Keywords: dock, casino]', entryUids: [], children: [
        { id: 'a1', label: 'Harbour', summary: 'The docks.', entryUids: [0, 99], children: [] },
        { id: 'a2', label: 'Casino row', summary: 'Neon.', entryUids: [4], children: [] },
      ] },
      { id: 'b', label: 'Ghost section', summary: 'Only deleted entries.', entryUids: [98], children: [] },
    ],
  };
  const tree = buildTree('Book', [entry(0, 'Dock'), entry(4, 'Casino'), entry(7, 'New entry')], tv, INDEXED)!;
  assert.equal(tree.source, 'tunnelvision');
  assert.deepEqual(tree.root.children.map(c => c.label), ['Places', 'New entry']);
  const places = tree.root.children[0]!;
  assert.equal(places.summary, 'Where things are.', 'the keyword list is stripped from summaries');
  assert.deepEqual(places.children.map(c => [c.label, c.entryUids]), [['Harbour', [0]], ['Casino row', [4]]]);
});

test('TunnelVision: entries on an internal node and oversized leaves become per-entry leaves', () => {
  const tv = { label: 'Root', entryUids: [], children: [
    { label: 'People', summary: 'Cast.', entryUids: [5], children: [{ label: 'Crew', summary: 'The crew.', entryUids: [1, 2, 3, 4], children: [] }] },
  ] };
  const tree = buildTree('Book', [1, 2, 3, 4, 5].map(uid => entry(uid, `P${uid}`)), tv, INDEXED)!;
  const people = tree.root.children[0]!;
  assert.deepEqual(people.children.map(c => c.label), ['Crew', 'P5']);
  assert.deepEqual(people.children[0]!.children.map(c => c.entryUids), [[1], [2], [3], [4]], 'a 4-entry leaf is split (limit 3)');
});

test('wide books are split into labelled groups so no frontier exceeds the option limit', () => {
  const many = Array.from({ length: 100 }, (_, i) => entry(i, `Entry ${String(i).padStart(3, '0')}`));
  const tree = buildTree('Book', many, null, { maxOptions: 10, maxLeafEntries: 3, excerptChars: 80, flatLimit: 0 })!;
  assert.ok(maxWidth(tree.root) <= 10, `max width ${maxWidth(tree.root)}`);
  assert.equal(entriesUnder(tree.root).length, 100, 'every entry is still reachable');
  assert.match(tree.root.children[0]!.summary, /^Contains: Entry 000; Entry 001/);
});

test('beam keeps clear contenders only, and nothing when NONE leads', () => {
  const keys = ['n1', 'n2', 'n3', 'n4'];
  const beam = { width: 3, minProbability: 0.15 };
  assert.deepEqual(beamPicks(choice({ n1: 0.5, n2: 0.3, n3: 0.12, n4: 0.03, NONE: 0.05 }), keys, beam).map(p => p.key), ['n1', 'n2'], 'n3 is below the floor');
  assert.deepEqual(beamPicks(choice({ n1: 0.4, n2: 0.15, NONE: 0.45 }), keys, beam), [], 'NONE leads');
  assert.deepEqual(beamPicks(choice({ n1: 0.35, n2: 0.3, NONE: 0.32, n3: 0.03 }), keys, beam).map(p => p.key), ['n1'], 'n2 is less likely than NONE');
  assert.deepEqual(beamPicks(choice({ n1: 0.25, n2: 0.25, n3: 0.25, n4: 0.2, NONE: 0.05 }), keys, beam).length, 3, 'width caps the picks');
  assert.deepEqual(beamPicks(choice({ n1: 0.6, n2: 0.25, NONE: 0.15 }), keys, beam).map(p => p.key), ['n1'], 'below half the leader');
});

test('beam without a distribution keeps the single choice (non-Jev providers)', () => {
  const bare: Answer = { type: 'choice', choice: 'n2', probabilities: null, provenance: 'model_reported', confidence: null };
  assert.deepEqual(beamPicks(bare, ['n1', 'n2'], { width: 3, minProbability: 0.15 }), [{ key: 'n2', p: 1 }]);
  assert.deepEqual(beamPicks({ ...bare, choice: 'NONE' }, ['n1', 'n2'], { width: 3, minProbability: 0.15 }), []);
});

test('frontier question lists children and NONE, and mentions the move only when there is one', () => {
  const tree = buildTree('Skyreach', [entry(0, 'Dock'), entry(1, 'Casino')].map(e => ({ ...e, world: 'Skyreach' })), null)!;
  const plain = frontierQuestion('Skyreach', tree.root, true, false);
  assert.deepEqual(Object.keys(plain.question.criteria as Record<string, string>), ['n1', 'n2', 'NONE']);
  assert.doesNotMatch(plain.question.instructions, /state\.move/);
  assert.match(frontierQuestion('Skyreach', tree.root, true, true).question.instructions, /state\.move/);
  assert.match(plain.question.instructions, /lorebook "Skyreach"/);
});

test('selectLore walks two books level by level in one request per level and ranks by path score', async () => {
  const tv = { label: 'Root', entryUids: [], children: [
    { label: 'Places', summary: 'Where.', entryUids: [], children: [
      { label: 'Harbour', summary: 'Docks.', entryUids: [0], children: [] },
      { label: 'Casino', summary: 'Neon.', entryUids: [1], children: [] },
    ] },
    { label: 'People', summary: 'Who.', entryUids: [2], children: [] },
  ] };
  const world = buildTree('World', [0, 1, 2].map(uid => ({ ...entry(uid, `W${uid}`), world: 'World' })), tv, INDEXED)!;
  const cast = buildTree('Cast', [0, 1].map(uid => ({ ...entry(uid, `C${uid}`), world: 'Cast' })), null)!;
  const asked: Record<string, Question>[] = [];
  const answersByLabel = (q: Question): Answer => {
    const text = q.instructions;
    if (text.includes('section "Places"')) return choice({ n1: 0.2, n2: 0.7, NONE: 0.1 });
    if (text.includes('"World"')) return choice({ n1: 0.8, n2: 0.1, NONE: 0.1 });
    return choice({ n1: 0.05, n2: 0.9, NONE: 0.05 });
  };
  const selection = await selectLore([world, cast], async (questions) => {
    asked.push(questions);
    return result(Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, answersByLabel(q)])));
  });
  assert.equal(selection.requests, 2, 'level 1 (both books) then level 2 (Places)');
  assert.equal(Object.keys(asked[0]!).length, 2);
  assert.deepEqual(selection.refs.map(r => `${r.world}.${r.title}`), ['Cast.C1', 'World.W1'], 'Harbour (0.2) is under half of Casino (0.7)');
  assert.ok(Math.abs(selection.refs[1]!.score - 0.56) < 1e-9, 'Places 0.8 × Casino 0.7');
  assert.equal(selection.cutShort, false);
});

test('selectLore honours the entry cap, the depth limit and the batch limit', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ ...entry(i, `E${i}`), world: 'Big' }));
  const big = buildTree('Big', many, null, { maxOptions: 5, maxLeafEntries: 3, excerptChars: 40, flatLimit: 0 })!;
  const everything = async (questions: Record<string, Question>) => result(Object.fromEntries(Object.entries(questions).map(([id, q]) => {
    const keys = Object.keys(q.criteria as Record<string, string>).filter(k => k !== 'NONE');
    return [id, choice(Object.fromEntries([...keys.map(k => [k, 0.9 / keys.length] as const), ['NONE', 0.1] as const]))];
  })));
  const capped = await selectLore([big], everything, { width: 3, minProbability: 0.1, maxEntries: 2, maxDepth: 6 });
  assert.equal(capped.refs.length, 2);
  const shallow = await selectLore([big], everything, { width: 3, minProbability: 0.1, maxEntries: 6, maxDepth: 1 });
  assert.equal(shallow.requests, 1);
  assert.equal(shallow.refs.length, 0, 'only groups were reached');
  assert.equal(shallow.cutShort, true);

  const books = Array.from({ length: 20 }, (_, b) => buildTree(`B${b}`, [{ ...entry(0, 'X'), world: `B${b}` }, { ...entry(1, 'Y'), world: `B${b}` }], null)!);
  let calls = 0;
  const sizes: number[] = [];
  await selectLore(books, async (questions) => { calls += 1; sizes.push(Object.keys(questions).length); return everything(questions); }, { width: 1, minProbability: 0.1, maxEntries: 40, maxDepth: 1 }, { maxQuestions: 16 });
  assert.equal(calls, 2);
  assert.deepEqual(sizes.sort((a, b) => b - a), [16, 4]);
});

import { applyLorePlan } from '../../src/lore/apply.ts';
import { loreSceneState, runLoreStage } from '../../src/lore/stage.ts';
import { effectiveMode, lorePlan, normalizeLoreSettings } from '../../src/lore/settings.ts';

test('lore scene and leaf questions never include collapsed details, even before excerpt clipping', () => {
  const hidden = `<details><summary>Private</summary>LORE-HIDDEN-CANARY ${'x'.repeat(500)}</details>`;
  const scene = loreSceneState([{ actorId: 'npc', role: 'assistant', text: `Visible reply. ${hidden}` }], `Visible input. ${hidden}`, { npc: 'Character' }, 60000);
  const tree = buildTree('Book', [entry(1, `Visible title ${hidden}`, { content: `Visible start. ${hidden} Visible end.` })], null)!;
  const { question } = frontierQuestion('Book', tree.root, true, false, tree.entries);
  assert.doesNotMatch(JSON.stringify({ scene, question }), /LORE-HIDDEN-CANARY/);
  assert.match(JSON.stringify(question), /Visible end/);
  assert.match(JSON.stringify(scene), /Visible input/);
});

test('applyLorePlan: managed books keep constants and chosen entries (the scan can only activate listed entries)', () => {
  const managedKeyword = { world: 'Cast', uid: 1, constant: false };
  const managedConstant = { world: 'Cast', uid: 2, constant: true };
  const chosen = { world: 'Cast', uid: 3, constant: false };
  const other = { world: 'World', uid: 1, constant: false };
  const assisted = { world: 'World', uid: 4, constant: false };
  const global = [other, assisted];
  const character = [managedKeyword, managedConstant, chosen];
  const removed = applyLorePlan([global, character, [], null], { force: new Set(['Cast.3', 'World.4']), managed: new Set(['Cast']) });
  assert.equal(removed, 1);
  assert.deepEqual(character, [managedConstant, chosen]);
  assert.deepEqual(global, [other, assisted], 'unmanaged books keep keyword activation');
});

test('lorePlan and effectiveMode: judge-only books are never activated; TunnelVision-managed books drop to judge', () => {
  const settings = normalizeLoreSettings({ defaultMode: 'assist', books: { Secret: { mode: 'judge' }, Cast: { mode: 'managed', public: true }, Junk: { mode: 'bogus' } } });
  assert.equal(settings.books.Junk!.mode, 'assist', 'unknown modes fall back to the default');
  assert.equal(settings.books.Cast!.public, true);
  assert.equal(effectiveMode(settings, 'Cast', true), 'judge');
  assert.equal(effectiveMode(settings, 'Cast', false), 'managed');
  const plan = lorePlan([{ world: 'Secret', uid: 1 }, { world: 'Cast', uid: 2 }, { world: 'Other', uid: 3 }], w => effectiveMode(settings, w, false), ['Secret', 'Cast', 'Other']);
  assert.deepEqual([...plan.force], ['Cast.2', 'Other.3']);
  assert.deepEqual([...plan.managed], ['Cast']);
});

test('normalizeLoreSettings bounds numbers and survives garbage', () => {
  assert.equal(normalizeLoreSettings(null).defaultMode, 'assist');
  const s = normalizeLoreSettings({ maxEntries: 999, width: -3, minProbability: 'x', maxDepth: 2.6, judgeChars: 10 });
  assert.deepEqual([s.maxEntries, s.width, s.minProbability, s.maxDepth, s.judgeChars], [20, 1, 0.15, 3, 1000]);
});

test('runLoreStage: public and private books are walked in separate requests; evidence carries visibility', async () => {
  const pub = buildTree('Atlas', [{ ...entry(0, 'Harbour'), world: 'Atlas' }, { ...entry(1, 'Casino'), world: 'Atlas' }], null)!;
  const priv = buildTree('Juno', [{ ...entry(0, 'Divination'), world: 'Juno' }, { ...entry(1, 'Childhood'), world: 'Juno' }], null)!;
  const seen: Record<string, string[][]> = { public: [], private: [] };
  const evaluate = (partition: 'public' | 'private') => async (questions: Record<string, Question>) => {
    seen[partition]!.push(Object.values(questions).map(q => JSON.stringify(q)));
    return result(Object.fromEntries(Object.keys(questions).map(id => [id, choice({ n1: 0.8, n2: 0.1, NONE: 0.1 })])));
  };
  const out = await runLoreStage([{ tree: pub, public: true }, { tree: priv, public: false }], evaluate, { width: 2, minProbability: 0.15, maxEntries: 5, maxDepth: 3 });
  assert.equal(out.requests, 2);
  assert.ok(seen.public!.flat().every(q => !q.includes('Divination')), 'no private label in the public request');
  assert.deepEqual(out.evidence.map(e => [e.book, e.title, e.public]), [['Atlas', 'Harbour', true], ['Juno', 'Divination', false]]);
  const ids = out.steps.flatMap(s => Object.keys(s.questions));
  assert.equal(new Set(ids).size, ids.length, 'question ids are unique across partitions');
});

test('frontier options for sections list what the section holds, so a mis-filed entry can still be found', () => {
  const tv = { label: 'Root', entryUids: [], children: [
    { label: 'Fetish & Secret Life', summary: 'Her hidden life.', entryUids: [], children: [{ label: 'Online Persona', summary: 'Streams.', entryUids: [0], children: [] }, { label: 'Origins', summary: 'How it began.', entryUids: [1], children: [] }] },
    { label: 'Personal Profile', summary: 'Who she is.', entryUids: [], children: [{ label: 'Physicality', summary: 'Body.', entryUids: [2], children: [] }, { label: 'Routine', summary: 'Days.', entryUids: [3], children: [] }] },
  ] };
  const tree = buildTree('Isla', [0, 1, 2, 3].map(uid => ({ ...entry(uid, ['Persona', 'Origins', 'Feet & Socks', 'Routine'][uid]!), world: 'Isla' })), tv, INDEXED)!;
  const { question } = frontierQuestion('Isla', tree.root, true, false, tree.entries);
  const criteria = question.criteria as Record<string, string>;
  assert.match(criteria.n2!, /^Personal Profile: Who she is\. Includes: Feet & Socks; Routine$/, 'entry titles, not leaf labels');
  const leafLevel = frontierQuestion('Isla', tree.root.children[1]!, false, false, tree.entries).question.criteria as Record<string, string>;
  assert.doesNotMatch(leafLevel.n1!, /Includes/, 'leaves describe themselves');
});

test('backtracking: when every section taken turns out empty, the best alternative is tried once', async () => {
  const tv = { label: 'Root', entryUids: [], children: [
    { label: 'Fetish', summary: 'Hidden life.', entryUids: [], children: [{ label: 'Persona', summary: 'Streams.', entryUids: [0], children: [] }, { label: 'Origins', summary: 'Began.', entryUids: [1], children: [] }] },
    { label: 'Profile', summary: 'Who she is.', entryUids: [], children: [{ label: 'Body', summary: 'Feet and socks.', entryUids: [2], children: [] }, { label: 'Routine', summary: 'Days.', entryUids: [3], children: [] }] },
    { label: 'Friends', summary: 'People.', entryUids: [], children: [{ label: 'Wren', summary: 'Roommate.', entryUids: [4], children: [] }, { label: 'Nell', summary: 'Upstairs.', entryUids: [5], children: [] }] },
  ] };
  const tree = buildTree('Isla', [0, 1, 2, 3, 4, 5].map(uid => ({ ...entry(uid, `E${uid}`), world: 'Isla' })), tv, INDEXED)!;
  const script = (q: Question): Answer => {
    const text = q.instructions;
    if (text.includes('section "Fetish"')) return choice({ n1: 0.1, n2: 0.1, NONE: 0.8 });
    if (text.includes('section "Profile"')) return choice({ n1: 0.9, n2: 0.05, NONE: 0.05 });
    return choice({ n1: 0.7, n2: 0.14, n3: 0.03, NONE: 0.13 }); // root: Fetish; Profile under the floor but above NONE
  };
  const asked: string[] = [];
  const out = await selectLore([tree], async (questions) => {
    asked.push(...Object.values(questions).map(q => q.instructions.match(/section "([^"]+)"|lorebook "([^"]+)"/)![0]));
    return result(Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, script(q)])));
  });
  assert.deepEqual(out.refs.map(r => r.title), ['E2'], 'Profile › Body was reached after Fetish came up empty');
  assert.equal(out.requests, 3);
  assert.deepEqual(asked, ['lorebook "Isla"', 'section "Fetish"', 'section "Profile"']);
  assert.equal(out.steps[1]!.frontiers[0]!.fellBackTo, tree.root.children[1]!.id);
});

test('backtracking never fires when a leaf was found beside the empty section, or when no alternative clears the floor', async () => {
  const tv = { label: 'Root', entryUids: [], children: [
    { label: 'Fetish', summary: 'Hidden life.', entryUids: [], children: [{ label: 'Persona', summary: 'Streams.', entryUids: [0], children: [] }, { label: 'Origins', summary: 'Began.', entryUids: [1], children: [] }] },
    { label: 'Profile', summary: 'Who she is.', entryUids: [], children: [{ label: 'Body', summary: 'Feet.', entryUids: [2], children: [] }, { label: 'Routine', summary: 'Days.', entryUids: [3], children: [] }] },
    { label: 'Note', summary: 'A single note.', entryUids: [4], children: [] },
  ] };
  const tree = buildTree('Isla', [0, 1, 2, 3, 4].map(uid => ({ ...entry(uid, `E${uid}`), world: 'Isla' })), tv, INDEXED)!;
  const run = (root: Record<string, number>) => selectLore([tree], async (questions) => result(Object.fromEntries(Object.entries(questions).map(([id, q]) => [id,
    q.instructions.includes('section "Fetish"') ? choice({ n1: 0.1, n2: 0.1, NONE: 0.8 }) : q.instructions.includes('section "Profile"') ? choice({ n1: 0.9, NONE: 0.1 }) : choice(root)]))));
  const withLeaf = await run({ n1: 0.5, n3: 0.4, n2: 0.02, NONE: 0.08 });
  assert.deepEqual(withLeaf.refs.map(r => r.title), ['E4'], 'the leaf counted as a find, so no retry');
  assert.equal(withLeaf.requests, 2);
  const belowFloor = await run({ n1: 0.85, n2: 0.05, NONE: 0.1 });
  assert.deepEqual(belowFloor.refs, [], 'Profile at 0.05 is under half the floor and under NONE');
  assert.equal(belowFloor.requests, 2);
});

test('the beam floor drops on wide questions to twice the uniform share', async () => {
  const { beamFloor } = await import('../../src/lore/select.ts');
  assert.equal(beamFloor(4, 0.15), 0.15, 'narrow questions keep the configured floor');
  assert.ok(Math.abs(beamFloor(25, 0.15) - 2 / 26) < 1e-12);
  const keys = Array.from({ length: 25 }, (_, i) => `n${i + 1}`);
  const flat = choice({ n1: 0.15, n2: 0.14, n3: 0.12, n4: 0.11, n5: 0.1, NONE: 0.02, ...Object.fromEntries(keys.slice(5).map(k => [k, 0.018])) });
  assert.deepEqual(beamPicks(flat, keys, { width: 3, minProbability: 0.15 }).map(p => p.key), ['n1', 'n2', 'n3']);
});

test('an unanswered frontier fails its book instead of counting as "nothing needed", and uses no fallback', async () => {
  const tv = { label: 'Root', entryUids: [], children: [
    { label: 'A', summary: 'a', entryUids: [], children: [{ label: 'A1', summary: 'x', entryUids: [0], children: [] }, { label: 'A2', summary: 'y', entryUids: [1], children: [] }] },
    { label: 'B', summary: 'b', entryUids: [], children: [{ label: 'B1', summary: 'z', entryUids: [2], children: [] }, { label: 'B2', summary: 'w', entryUids: [3], children: [] }] },
  ] };
  const book = buildTree('Book', [0, 1, 2, 3].map(uid => entry(uid, 'E' + uid)), tv, INDEXED)!;
  const other = buildTree('Other', [{ ...entry(0, 'O0'), world: 'Other' }, { ...entry(1, 'O1'), world: 'Other' }], null)!;
  const out = await selectLore([book, other], async (questions) => {
    const answers: Record<string, Answer> = {};
    const errors: Record<string, string> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (q.instructions.includes('section "A"')) errors[id] = 'invalid choice';
      else if (q.instructions.includes('"Other"')) answers[id] = choice({ n1: 0.9, n2: 0.05, NONE: 0.05 });
      else answers[id] = choice({ n1: 0.8, n2: 0.12, NONE: 0.08 });
    }
    return { ...result(answers), errors, unresolvedQuestionIds: Object.keys(errors) };
  });
  assert.deepEqual(out.failedWorlds, ['Book']);
  assert.deepEqual(out.refs.map(r => r.title), ['O0']);
  const failedStep = out.steps[1]!.frontiers[0]!;
  assert.equal(failedStep.error, 'invalid choice');
  assert.equal(failedStep.fellBackTo, undefined, 'no fallback on a missing answer');
  assert.equal(out.requests, 2, 'B was never tried');
});

test('lorePlan: a book the judge could not walk keeps its keyword lore even when managed', () => {
  const plan = lorePlan([{ world: 'Cast', uid: 1 }], () => 'managed', ['Cast', 'World'], ['World']);
  assert.deepEqual([...plan.managed], ['Cast']);
  assert.deepEqual([...plan.force], ['Cast.1']);
});

test('runLoreStage: private picks can never push public ones out of the ruling\'s evidence', async () => {
  const pub = buildTree('Atlas', [0, 1, 2].map(uid => ({ ...entry(uid, 'A' + uid), world: 'Atlas' })), null)!;
  const priv = buildTree('Secret', [0, 1, 2].map(uid => ({ ...entry(uid, 'S' + uid), world: 'Secret' })), null)!;
  const evaluate = (partition: 'public' | 'private') => async (questions: Record<string, Question>) => result(Object.fromEntries(Object.keys(questions).map(id =>
    [id, partition === 'private' ? choice({ n1: 0.34, n2: 0.33, n3: 0.32, NONE: 0.01 }) : choice({ n1: 0.2, n2: 0.19, n3: 0.02, NONE: 0.59 - 0.0 })])));
  const lowPublic = (partition: 'public' | 'private') => partition === 'public'
    ? async (questions: Record<string, Question>) => result(Object.fromEntries(Object.keys(questions).map(id => [id, choice({ n1: 0.45, n2: 0.4, NONE: 0.15 })])))
    : evaluate('private');
  const out = await runLoreStage([{ tree: pub, public: true }, { tree: priv, public: false }], lowPublic, { width: 3, minProbability: 0.15, maxEntries: 2, maxDepth: 2 });
  assert.deepEqual(out.refs.map(r => r.title), ['A0', 'A1'], 'the writer cap is shared');
  const publicEvidence = out.evidence.filter(e => e.public).map(e => e.title);
  assert.deepEqual(publicEvidence, ['A0', 'A1'], 'public evidence is capped on its own');
  assert.equal(out.evidence.filter(e => !e.public).length, 2);
});

import { summarizeActivation } from '../../src/lore/apply.ts';

test('summarizeActivation: entries, characters and Director picks per book', () => {
  const out = summarizeActivation([
    { world: 'Atlas', uid: 0, content: 'abcd' }, { world: 'Atlas', uid: 1, content: 'efgh' },
    { world: 'Cast', uid: 3, content: 'xy' }, null, { uid: 9, content: 'orphan' },
  ], new Set(['Cast.3']), 42);
  assert.deepEqual(out, { at: 42, books: { Atlas: { entries: 2, chars: 8, picked: 0 }, Cast: { entries: 1, chars: 2, picked: 1 } } });
});
