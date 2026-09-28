import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStaged, StagedError } from '../../src/pipeline/staged.ts';
import type { StagedInput, StageId } from '../../src/pipeline/staged.ts';
import { DEFAULT_PACK } from '../../src/pack/pack.ts';
import type { Answer, EvaluationResult, Json, Question } from '../../src/types.ts';

const choice = (value: string): Answer => ({ type: 'choice', choice: value, probabilities: null, confidence: null, provenance: 'fixture' } as Answer);
const noul = (value: number): Answer => ({ type: 'noul', noul: value, confidence: null, provenance: 'fixture' } as Answer);

interface Call { stage: StageId; questions: Record<string, Question>; state: Json }

function fakeEnv(script: Record<string, Answer>) {
  const calls: Call[] = [];
  return {
    calls,
    env: {
      async evaluate(stage: StageId, questions: Record<string, Question>, state: Json): Promise<EvaluationResult> {
        calls.push({ stage, questions, state });
        const answers: Record<string, Answer> = {};
        for (const id of Object.keys(questions)) if (script[id]) answers[id] = script[id]!;
        return { requestId: `r${calls.length}`, provider: 'mock', requestedModel: null, returnedModel: 'fixture', answers, unresolvedQuestionIds: [], errors: {}, inputTokens: null, outputTokens: null, durationMs: 1, transportAttempts: 1 };
      },
    },
  };
}

const EMILY_CARD = 'Isla is teasing and competitive; she wants her cousin to say what he wants out loud. CARD-MARK';

function baseInput(overrides: Partial<StagedInput> = {}): StagedInput {
  return {
    pack: DEFAULT_PACK,
    playerId: 'player',
    actors: {
      player: { name: 'Jordan', control: 'user' },
      isla: { name: 'Isla', control: 'npc', card: EMILY_CARD },
    },
    eligibleNpcIds: ['isla'],
    latestInput: 'I sit up. "Go ahead, make me do what you want."',
    transcript: [
      { actorId: 'isla', role: 'assistant', text: 'She crosses her arms. "Say it out loud. I am not dragging you anywhere." <details><summary>x</summary>private thought</details> "Your move, cousin."' },
    ],
    facts: {},
    modules: { speaker: true, decisions: true, reactions: true },
    speakerQuestion: null,
    reactionQuestions: {},
    maxChars: 60000,
    ...overrides,
  };
}

test('no move: only stage A runs', async () => {
  const { env, calls } = fakeEnv({ move: choice('NONE'), move_count: choice('one') });
  const out = await runStaged(baseInput(), env);
  assert.equal(out.outcome, 'no_move');
  assert.deepEqual(calls.map(c => c.stage), ['move']);
  assert.equal(out.route, null);
  assert.equal(out.ruling, null);
});

test('a direct attempt runs A, B and E, and only E sees the target card', async () => {
  const { env, calls } = fakeEnv({
    move: choice('s1'), move_count: choice('one'),
    owner: choice('player'), target: choice('isla'), family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'),
    ruling: noul(0.42),
  });
  const out = await runStaged(baseInput({ latestInput: 'I ask her to move her feet onto my lap.' }), env);
  assert.equal(out.outcome, 'ruled');
  assert.deepEqual(calls.map(c => c.stage), ['move', 'route', 'ruling']);
  assert.equal(out.move!.span.text, 'I ask her to move her feet onto my lap.');
  assert.equal((calls[1]!.state as { move: { passage: string } }).move.passage, 'I ask her to move her feet onto my lap.');
  assert.ok(!JSON.stringify(calls[0]!.state).includes('CARD-MARK'), 'A is public-only');
  assert.ok(!JSON.stringify(calls[1]!.state).includes('CARD-MARK'), 'B is public-only');
  assert.ok(JSON.stringify(calls[2]!.state).includes('CARD-MARK'), 'E reads the target card for influence');
  assert.ok(!JSON.stringify(calls).includes('private thought'), 'collapsed thoughts never reach any stage');
  assert.equal(out.route!.route, 'DIRECT_ATTEMPT');
  assert.equal(out.ruling!.answer.type, 'noul');
  assert.equal(calls[2]!.questions.ruling!.type, 'noul');
});

test('a hand-off stops after routing with no ruling', async () => {
  const { env, calls } = fakeEnv({
    move: choice('s2'), move_count: choice('one'),
    owner: choice('isla'), target: choice('player'), family: choice('UNSUPPORTED'), action_specification: choice('UNSPECIFIED_INITIATIVE'), antecedent: choice('NONE'),
  });
  const out = await runStaged(baseInput(), env);
  assert.equal(out.outcome, 'handoff');
  assert.deepEqual(calls.map(c => c.stage), ['move', 'route']);
  assert.equal(out.route!.ownerId, 'isla');
  assert.equal(out.move!.span.text, '"Go ahead, make me do what you want."');
});

test('unresolved routing is explicitly unruled', async () => {
  const { env, calls } = fakeEnv({
    move: choice('s1'), move_count: choice('one'),
    owner: choice('UNRESOLVED'), target: choice('isla'), family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'),
  });
  const out = await runStaged(baseInput(), env);
  assert.equal(out.outcome, 'unruled');
  assert.match(out.route!.reason, /owner/);
  assert.equal(calls.length, 2);
});

test('the earlier passage a move refers to comes from the NPC\'s visible text and reaches the ruling', async () => {
  const { env, calls } = fakeEnv({
    move: choice('s1'), move_count: choice('one'),
    owner: choice('player'), target: choice('isla'), family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_BY_PUBLIC_REFERENCE'), antecedent: choice('a2'),
    ruling: noul(0.5),
  });
  const out = await runStaged(baseInput({ latestInput: 'Fine, I accept the terms you set.' }), env);
  const antecedentCriteria = calls[1]!.questions.antecedent!.criteria as Record<string, string>;
  assert.equal(antecedentCriteria.a2, '"Say it out loud.');
  assert.ok(!Object.values(antecedentCriteria).some(text => text.includes('private thought')));
  assert.equal(out.antecedentText, '"Say it out loud.');
  assert.equal((calls[2]!.state as { move: { antecedent: string } }).move.antecedent, '"Say it out loud.');
  assert.match(calls[2]!.questions.ruling!.instructions, /state\.move\.antecedent/);
});

test('in a group the speaker runs in its own request alongside A', async () => {
  const speakerQuestion: Question = { type: 'choice', instructions: 'Which eligible NPC should speak next given the exchange?', criteria: { isla: 'Isla', wren: 'Wren', YIELD: 'none' } };
  const { env, calls } = fakeEnv({
    speaker: choice('isla'), move: choice('s1'), move_count: choice('one'),
    owner: choice('player'), target: choice('isla'), family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'),
    ruling: noul(0.3),
  });
  const out = await runStaged(baseInput({ speakerQuestion, latestInput: 'I ask her to stay.' }), env);
  assert.deepEqual(calls.map(c => c.stage).sort(), ['move', 'route', 'ruling', 'speaker']);
  assert.equal(calls.length, 4);
  const speakerCall = calls.find(c => c.stage === 'speaker')!;
  assert.deepEqual(Object.keys(speakerCall.questions), ['speaker']);
  assert.equal(out.speakerAnswer?.type, 'choice');
});

test('reaction triggers ride in the move request; with Decisions off they ride alone', async () => {
  const reactionQuestions: Record<string, Question> = { isla: { type: 'choice', instructions: 'Select at most one concrete NPC reaction trigger for Isla.', criteria: { none: 'n', resolve: 'r', secret: 's', exposure: 'e' } } };
  const on = fakeEnv({ move: choice('NONE'), move_count: choice('one'), npc_reaction_1: choice('resolve') });
  const out = await runStaged(baseInput({ reactionQuestions }), on.env);
  assert.deepEqual(Object.keys(on.calls[0]!.questions).sort(), ['move', 'move_count', 'npc_reaction_1']);
  assert.equal(out.reactionAnswers.isla?.type, 'choice');
  const off = fakeEnv({ npc_reaction_1: choice('resolve') });
  const alone = await runStaged(baseInput({ reactionQuestions, modules: { speaker: true, decisions: false, reactions: true } }), off.env);
  assert.deepEqual(Object.keys(off.calls[0]!.questions), ['npc_reaction_1']);
  assert.equal(off.calls.length, 1);
  assert.equal(alone.outcome, 'no_move');
});

test('speaker only is one request; everything off is none', async () => {
  const speakerQuestion: Question = { type: 'choice', instructions: 'Which eligible NPC should speak next given the exchange?', criteria: { isla: 'Isla', YIELD: 'none' } };
  const only = fakeEnv({ speaker: choice('isla') });
  await runStaged(baseInput({ speakerQuestion, modules: { speaker: true, decisions: false, reactions: false } }), only.env);
  assert.deepEqual(only.calls.map(c => c.stage), ['speaker']);
  const none = fakeEnv({});
  const out = await runStaged(baseInput({ modules: { speaker: false, decisions: false, reactions: false } }), none.env);
  assert.equal(none.calls.length, 0);
  assert.equal(out.outcome, 'no_move');
});

test('a missing answer from a required stage stops the turn instead of guessing', async () => {
  const { env } = fakeEnv({ move_count: choice('one') });
  await assert.rejects(runStaged(baseInput(), env), (error: unknown) => error instanceof StagedError && error.stage === 'move');
  const noRuling = fakeEnv({
    move: choice('s1'), move_count: choice('one'),
    owner: choice('player'), target: choice('isla'), family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'),
  });
  await assert.rejects(runStaged(baseInput({ latestInput: 'I ask her to stay.' }), noRuling.env), (error: unknown) => error instanceof StagedError && error.stage === 'ruling');
});

test('a bundled message is recorded so later moves stay pending', async () => {
  const { env } = fakeEnv({
    move: choice('s1'), move_count: choice('multiple'),
    owner: choice('player'), target: choice('SCENE'), family: choice('overcome_operate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'),
    ruling: noul(0.6),
  });
  const out = await runStaged(baseInput({ latestInput: 'I pick the lock. Then I sneak past the guard.' }), env);
  assert.equal(out.move!.count, 'multiple');
});

test('a routine message is treated like no move: nothing after stage A', async () => {
  const { env, calls } = fakeEnv({ move: choice('ROUTINE'), move_count: choice('one') });
  const out = await runStaged(baseInput({ latestInput: 'I head to my throne room and have my steward summon the advisors.' }), env);
  assert.equal(out.outcome, 'no_move');
  assert.equal(calls.length, 1);
});

test('the ruling waits for the freshly judged meters and reads the target\'s', async () => {
  const { env, calls } = fakeEnv({
    move: choice('s1'), move_count: choice('one'),
    owner: choice('player'), target: choice('isla'), family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'),
    ruling: noul(0.4),
  });
  let resolveMeters!: (value: Record<string, Record<string, string>>) => void;
  const meters = new Promise<Record<string, Record<string, string>>>(resolve => { resolveMeters = resolve; });
  const running = runStaged(baseInput({ latestInput: 'I ask her to stay.', meters: () => meters }), env);
  await new Promise(resolve => setImmediate(resolve));
  resolveMeters({ isla: { 'regard for Jordan': 'warm (4 of 5)' } });
  await running;
  assert.match(JSON.stringify(calls.find(c => c.stage === 'ruling')!.state), /warm \(4 of 5\)/);
});
