import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStaged, stageError, validateStageAnswers } from '../../src/pipeline/staged.ts';
import type { StagedInput, StageId } from '../../src/pipeline/staged.ts';
import { DEFAULT_PACK } from '../../src/pack/pack.ts';
import type { Answer, EvaluationResult, Json, Question } from '../../src/types.ts';
import { ProviderError } from '../../src/providers.ts';

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

test('a missing move or ruling answer leaves the turn unruled without throwing or guessing', async () => {
  const { env } = fakeEnv({ move_count: choice('one') });
  const missingMove = await runStaged(baseInput(), env);
  assert.equal(missingMove.outcome, 'unruled');
  assert.equal(missingMove.ruling, null);
  assert.equal(missingMove.errors[0]?.stage, 'move');
  assert.equal(missingMove.errors[0]?.type, 'invalid_answers');
  const noRuling = fakeEnv({
    move: choice('s1'), move_count: choice('one'),
    owner: choice('player'), target: choice('isla'), family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'),
  });
  const missingRuling = await runStaged(baseInput({ latestInput: 'I ask her to stay.' }), noRuling.env);
  assert.equal(missingRuling.outcome, 'unruled');
  assert.equal(missingRuling.ruling, null);
  assert.equal(missingRuling.errors[0]?.stage, 'ruling');
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

const validMove: Record<string, Answer> = {
  move: choice('s1'), move_count: choice('one'),
  owner: choice('player'), target: choice('isla'), family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'),
  ruling: noul(0.4),
};
const speakerQuestion: Question = { type: 'choice', instructions: 'Choose the next speaker.', criteria: { isla: 'Isla', YIELD: 'none' } };
const reactionQuestion: Question = { type: 'choice', instructions: 'Choose one reaction.', criteria: { none: 'none', resolve: 'resolve' } };

test('a speaker network failure preserves the independent move and ruling', async () => {
  const fixture = fakeEnv(validMove);
  const out = await runStaged(baseInput({ speakerQuestion }), {
    async evaluate(stage, questions, state) {
      if (stage === 'speaker') throw new ProviderError('network', 'Connection lost.');
      return fixture.env.evaluate(stage, questions, state);
    },
  });
  assert.equal(out.outcome, 'ruled');
  assert.equal(out.speakerAnswer, null);
  assert.equal(out.ruling?.answer.type, 'noul');
  assert.deepEqual(out.errors, [{ stage: 'speaker', type: 'network', message: 'Connection lost.' }]);
});

test('an invalid move leaves successful speaker and reaction answers intact', async () => {
  const fixture = fakeEnv({ speaker: choice('isla'), move: choice('invented'), move_count: choice('one'), npc_reaction_1: choice('resolve') });
  const out = await runStaged(baseInput({ speakerQuestion, reactionQuestions: { isla: reactionQuestion } }), fixture.env);
  assert.equal(out.outcome, 'unruled');
  assert.equal(out.ruling, null);
  assert.equal(out.speakerAnswer?.type === 'choice' && out.speakerAnswer.choice, 'isla');
  assert.equal(out.reactionAnswers.isla?.type === 'choice' && out.reactionAnswers.isla.choice, 'resolve');
  assert.equal(out.errors[0]?.type, 'invalid_answers');
  assert.equal(fixture.calls.length, 2);
});

test('an invalid reaction never erases the valid move ruling in the same batch', async () => {
  const fixture = fakeEnv({ ...validMove, npc_reaction_1: choice('invented') });
  const out = await runStaged(baseInput({ reactionQuestions: { isla: reactionQuestion } }), fixture.env);
  assert.equal(out.outcome, 'ruled');
  assert.deepEqual(out.reactionAnswers, {});
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0]!.message, /npc_reaction_1/);
});

test('an incomplete move count is unruled rather than guessing which moves to bind', async () => {
  const fixture = fakeEnv({ move: choice('s1') });
  const out = await runStaged(baseInput(), fixture.env);
  assert.equal(out.outcome, 'unruled');
  assert.equal(out.move?.count, null);
  assert.equal(fixture.calls.length, 1);
  assert.match(out.errors[0]!.message, /move_count/);
});

test('routing refusal and timeout keep prior independent decisions without a ruling', async () => {
  for (const code of ['refusal', 'timeout'] as const) {
    const fixture = fakeEnv({ ...validMove, speaker: choice('isla'), npc_reaction_1: choice('resolve') });
    const out = await runStaged(baseInput({ speakerQuestion, reactionQuestions: { isla: reactionQuestion } }), {
      async evaluate(stage, questions, state) {
        if (stage === 'route') throw new ProviderError(code, `Route ${code}.`);
        return fixture.env.evaluate(stage, questions, state);
      },
    });
    assert.equal(out.outcome, 'unruled');
    assert.ok(out.speakerAnswer);
    assert.ok(out.reactionAnswers.isla);
    assert.equal(out.ruling, null);
    assert.equal(out.errors[0]?.stage, 'route');
    assert.equal(out.errors[0]?.type, code);
    assert.ok(!fixture.calls.some(call => call.stage === 'ruling'));
  }
});

test('a malformed routing choice cannot reach the ruling stage', async () => {
  const fixture = fakeEnv({ ...validMove, target: choice('unknown-character') });
  const out = await runStaged(baseInput(), fixture.env);
  assert.equal(out.outcome, 'unruled');
  assert.equal(out.route?.route, 'UNRULED');
  assert.equal(out.ruling, null);
  assert.equal(out.errors[0]?.stage, 'route');
  assert.ok(!fixture.calls.some(call => call.stage === 'ruling'));
});

test('nonfinite, out-of-range and wrong-primitive rulings are unruled', async () => {
  for (const invalid of [noul(NaN), noul(Infinity), noul(-0.1), noul(1.1), choice('yes')]) {
    const fixture = fakeEnv({ ...validMove, ruling: invalid });
    const out = await runStaged(baseInput(), fixture.env);
    assert.equal(out.outcome, 'unruled');
    assert.equal(out.ruling, null);
    assert.equal(out.errors[0]?.type, 'invalid_answers');
  }
});

test('over-budget public context makes no request, and over-budget ruling context leaves only the ruling unruled', async () => {
  const noRoom = fakeEnv(validMove);
  const publicFailure = await runStaged(baseInput({ maxChars: 20 }), noRoom.env);
  assert.equal(noRoom.calls.length, 0);
  assert.equal(publicFailure.outcome, 'unruled');
  assert.equal(publicFailure.errors[0]?.type, 'context_budget');
  const fixture = fakeEnv(validMove);
  const rulingFailure = await runStaged(baseInput({
    actors: { player: { name: 'Player', control: 'user' }, isla: { name: 'Isla', control: 'npc', card: 'x'.repeat(5000) } },
    maxChars: 2000,
  }), fixture.env);
  assert.equal(rulingFailure.outcome, 'unruled');
  assert.deepEqual(fixture.calls.map(call => call.stage), ['move', 'route']);
  assert.equal(rulingFailure.errors[0]?.stage, 'ruling');
  assert.equal(rulingFailure.errors[0]?.type, 'context_budget');
});

test('failed meter and lore requests omit those parts but preserve a valid independent ruling', async () => {
  const fixture = fakeEnv(validMove);
  const out = await runStaged(baseInput({
    meters: async () => { throw new ProviderError('network', 'Meters unavailable.'); },
    lore: async () => { throw new ProviderError('refusal', 'Lore request refused.'); },
  }), fixture.env);
  assert.equal(out.outcome, 'ruled');
  assert.deepEqual(out.errors.map(error => [error.stage, error.type]), [['state', 'network'], ['lore', 'refusal']]);
  assert.doesNotMatch(JSON.stringify(fixture.calls.find(call => call.stage === 'ruling')?.state), /judgedState|"lore"/);
});

test('large reaction groups are split into requests of at most 16 questions', async () => {
  const reactionQuestions: Record<string, Question> = {};
  const script = { ...validMove };
  for (let i = 1; i <= 37; i++) {
    reactionQuestions[`npc${i}`] = reactionQuestion;
    script[`npc_reaction_${i}`] = choice('resolve');
  }
  const fixture = fakeEnv(script);
  const out = await runStaged(baseInput({ reactionQuestions }), fixture.env);
  assert.equal(out.outcome, 'ruled');
  assert.equal(Object.keys(out.reactionAnswers).length, 37);
  assert.deepEqual(fixture.calls.filter(call => call.stage === 'move').map(call => Object.keys(call.questions).length), [16, 16, 7]);
  assert.ok(fixture.calls.every(call => Object.keys(call.questions).length <= 16));
});

test('collapsed details in the latest message never reach move, routing or ruling questions or state', async () => {
  const fixture = fakeEnv(validMove);
  const out = await runStaged(baseInput({ latestInput: 'I ask her to stay. <details><summary>Secret</summary>LATEST-HIDDEN</details>' }), fixture.env);
  assert.equal(out.outcome, 'ruled');
  assert.equal(out.move?.span.text, 'I ask her to stay.');
  assert.doesNotMatch(JSON.stringify(fixture.calls), /LATEST-HIDDEN/);
});

test('provider errors and unresolved markers override even superficially valid answers', async () => {
  const fixture = fakeEnv({ ruling: noul(0.5) });
  const result = await fixture.env.evaluate('ruling', { ruling: { type: 'noul', instructions: 'Rule.' } }, {});
  const failures: Pick<EvaluationResult, 'errors' | 'unresolvedQuestionIds'>[] = [{ errors: { ruling: 'The request was refused.' }, unresolvedQuestionIds: [] }, { errors: {}, unresolvedQuestionIds: ['ruling'] }];
  for (const failure of failures) {
    const validated = validateStageAnswers('ruling', { ruling: { type: 'noul', instructions: 'Rule.' } }, { ...result, ...failure });
    assert.deepEqual(validated.result.answers, {});
    assert.equal(validated.errors.length, 1);
    assert.deepEqual(validated.result.unresolvedQuestionIds, ['ruling']);
  }
  assert.equal(stageError('ruling', new ProviderError('too_large', 'Too large.')).type, 'context_budget');
  assert.equal(stageError('ruling', new Error('The judge wait budget expired')).type, 'timeout');
});

test('malformed provider batches fail open', async () => {
  const out = await runStaged(baseInput(), { evaluate: async () => null as unknown as EvaluationResult });
  assert.equal(out.outcome, 'unruled');
  assert.equal(out.errors[0]?.type, 'invalid_answers');
  assert.equal(out.ruling, null);
});

test('a manual move bypasses selection and routing while preserving speaker/reaction stages and admissible evidence', async () => {
  const fixture = fakeEnv({ ruling: noul(0.35), speaker: choice('isla'), npc_reaction_1: choice('resolve') });
  const out = await runStaged(baseInput({
    speakerQuestion, reactionQuestions: { isla: reactionQuestion },
    manual: { text: 'I ask her to stay.', ownerId: 'player', targetId: 'isla', familyKey: 'influence_negotiate' },
  }), fixture.env);
  assert.equal(out.outcome, 'ruled');
  assert.equal(out.move?.span.text, 'I ask her to stay.');
  assert.equal(out.move?.count, 'one');
  assert.equal(out.route?.route, 'DIRECT_ATTEMPT');
  assert.deepEqual(fixture.calls.map(call => Object.keys(call.questions)), [['speaker'], ['npc_reaction_1'], ['ruling']]);
  assert.match(JSON.stringify(fixture.calls.at(-1)!.state), /CARD-MARK/);
});

test('manual discovery obeys the same card, meter, hidden-detail and private-lore firewall', async () => {
  const fixture = fakeEnv({ ruling: noul(0.35) });
  const out = await runStaged(baseInput({
    manual: { text: 'I look for the hidden key. <details>MANUAL-HIDDEN</details>', ownerId: 'player', targetId: null, familyKey: 'detect_discover' },
    meters: async () => ({ isla: { regard: 'METER-HIDDEN' } }),
    lore: async () => [{ book: 'Hidden', title: 'Secret key', text: 'PRIVATE-LORE-HIDDEN', public: false }],
  }), fixture.env);
  assert.equal(out.outcome, 'ruled');
  assert.equal(fixture.calls.length, 1);
  assert.equal(out.move?.span.text, 'I look for the hidden key.');
  assert.doesNotMatch(JSON.stringify(fixture.calls), /CARD-MARK|METER-HIDDEN|PRIVATE-LORE-HIDDEN|MANUAL-HIDDEN/);
});

test('invalid manual overrides remain unruled and decisions-off suppresses the override entirely', async () => {
  const fixture = fakeEnv({ ruling: noul(0.35) });
  const manual = { text: 'I ask her to stay.', ownerId: 'unknown', targetId: 'isla', familyKey: 'influence_negotiate' };
  const out = await runStaged(baseInput({ manual }), fixture.env);
  assert.equal(out.outcome, 'unruled');
  assert.equal(out.ruling, null);
  assert.equal(out.errors[0]?.stage, 'route');
  assert.equal(fixture.calls.length, 0);
  const disabled = await runStaged(baseInput({ manual, modules: { speaker: false, decisions: false, reactions: false } }), fixture.env);
  assert.equal(disabled.outcome, 'no_move');
  assert.equal(fixture.calls.length, 0);
});
