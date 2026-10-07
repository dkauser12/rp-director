import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjudicateTurnProposal, permitFollowupBlock, validateTurnProposal } from '../../src/director-tool.ts';
import { profileById } from '../../src/profiles.ts';
import type { Answer, DecisionProvider, EvaluationResult, TurnProposal } from '../../src/types.ts';
import { createMockProvider } from '../../src/providers.ts';
import { StagedError } from '../../src/pipeline/staged.ts';

const context = {
  requestId: 'toolreq-1', attemptId: 'attempt-1', speakerActorId: 'npc-a',
  knownActorIds: ['player', 'npc-a', 'npc-b'], allowedEvidenceRefs: ['msg:4', 'state:door'],
};

const proposal = (overrides: Partial<TurnProposal> = {}): TurnProposal => ({
  schemaVersion: 1,
  requestId: context.requestId,
  attemptId: context.attemptId,
  speakerActorId: context.speakerActorId,
  actions: [{
    proposalId: 'p1', actingActorId: 'npc-a', targetActorIds: ['player'], family: 'contest_impose',
    method: 'tries to wrench the satchel free', boundedResult: 'the satchel leaves the player’s grasp',
    failureStake: { kind: 'lost_position', detail: 'the NPC loses leverage and the satchel stays put' },
    opposed: true, evidenceRefs: ['msg:4'],
  }],
  ...overrides,
});

test('tool proposal accepts one bounded speaker action and canonicalizes targets', () => {
  const raw = proposal();
  raw.actions[0]!.targetActorIds = ['npc-b', 'player'];
  const result = validateTurnProposal(raw, context);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.proposal.actions[0]!.targetActorIds, ['npc-b', 'player']);
});

test('fourth planned action returns typed too_many_actions before any decision', () => {
  const action = proposal().actions[0]!;
  const result = validateTurnProposal(proposal({ actions: [action, { ...action, proposalId: 'p2' }, { ...action, proposalId: 'p3' }, { ...action, proposalId: 'p4' }] }), context);
  assert.deepEqual(result.ok ? null : result.code, 'too_many_actions');
});

test('tool proposal cannot change speaker, cite unknown evidence, include draft fields, or author feelings', () => {
  const wrongActor = proposal(); wrongActor.actions[0]!.actingActorId = 'npc-b';
  assert.equal(validateTurnProposal(wrongActor, context).ok ? null : (validateTurnProposal(wrongActor, context) as any).code, 'speaker_mismatch');
  const unknownEvidence = proposal(); unknownEvidence.actions[0]!.evidenceRefs = ['msg:secret'];
  assert.equal(validateTurnProposal(unknownEvidence, context).ok ? null : (validateTurnProposal(unknownEvidence, context) as any).code, 'unknown_evidence');
  const feelings = proposal(); feelings.actions[0]!.boundedResult = 'the player falls in love';
  assert.equal(validateTurnProposal(feelings, context).ok ? null : (validateTurnProposal(feelings, context) as any).code, 'forbidden_result');
  const draft = proposal() as unknown as Record<string, unknown>; draft.replyDraft = 'full prose';
  assert.equal(validateTurnProposal(draft, context).ok ? null : (validateTurnProposal(draft, context) as any).code, 'unknown_field');
});

test('adjudication makes one batch call and freezes an attempt-scoped permit', async () => {
  let calls = 0;
  const provider: DecisionProvider = {
    kind: 'mock',
    capabilities: { primitives: ['noul'], distributions: 'unavailable', confidence: 'unavailable', structuredOutput: 'in_process', independentSharedStateBatch: true, maxQuestions: null, cancellation: 'abort_signal', usageReporting: false },
    async evaluate(request) {
      calls += 1;
      return {
        requestId: request.requestId, provider: 'mock', requestedModel: 'fixture', returnedModel: null,
        answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: 'noul', noul: 0.8, confidence: null, provenance: 'fixture' }])),
        unresolvedQuestionIds: [], errors: {}, inputTokens: null, outputTokens: null, durationMs: 2, transportAttempts: 1,
      };
    },
  };
  const validated = validateTurnProposal(proposal(), context);
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const profile = profileById('binding');
  assert.ok(profile);
  const result = await adjudicateTurnProposal({
    proposal: validated.proposal, provider, profile,
    snapshot: { chatId: 'chat', cursorBefore: 'c0', stateRevision: 4, scopeId: 'shared-public', profileRevision: profile.revision, catalogRevision: '', actorBindingRevision: '', state: { sceneId: 2 } },
    actorNames: { player: 'Player', 'npc-a': 'A', 'npc-b': 'B' }, playerName: 'Player', signal: new AbortController().signal, now: 10,
  });
  assert.equal(calls, 1);
  assert.equal(result.permit.actions.length, 1);
  assert.equal(result.permit.actions[0]!.scope, 'attempt');
  assert.equal(result.permit.baseCursor, 'c0');
  assert.equal(result.permit.stateRevision, 4);
  assert.ok(result.permit.constraints.includes('Do not output Director data or metadata such as permits, rulings, request IDs, actor IDs, evidence references, or JSON. This does not prohibit a preset-required fictional tracker block.'));
  assert.match(permitFollowupBlock(result.permit), /This does not prohibit a preset-required fictional tracker block/);
  assert.doesNotMatch(permitFollowupBlock(result.permit), /state\/metadata blocks|Do not output state blocks/);
});

test('planned actions cannot push the frozen snapshot past the context limit', async () => {
  const profile = profileById('binding')!;
  profile.budgets = { ...profile.budgets, maxSerializedCharacters: 1000 };
  const state = { latestInput: 'x'.repeat(900) };
  assert.ok(JSON.stringify(state).length < profile.budgets.maxSerializedCharacters);
  let calls = 0;
  const provider: DecisionProvider = {
    ...createMockProvider({ scenario: 'default' }),
    async evaluate() { calls++; throw new Error('unexpected judge call'); },
  };
  await assert.rejects(adjudicateTurnProposal({
    proposal: proposal(), provider, profile,
    snapshot: { chatId: 'chat', cursorBefore: 'c0', stateRevision: 4, scopeId: 'shared-public', profileRevision: profile.revision, catalogRevision: '', actorBindingRevision: '', state },
    actorNames: { player: 'Player', 'npc-a': 'A' }, playerName: 'Player', signal: new AbortController().signal,
  }), /context.*limit/i);
  assert.equal(calls, 0);
});

function adjudicationInput(provider: DecisionProvider, raw = proposal()) {
  const profile = profileById('binding')!;
  return {
    proposal: raw, provider, profile,
    snapshot: { chatId: 'chat', cursorBefore: 'c0', stateRevision: 0, scopeId: 'shared-public', profileRevision: profile.revision, catalogRevision: '', actorBindingRevision: '', state: { latestInput: 'I hold the satchel tightly.' } },
    actorNames: { player: 'Player', 'npc-a': 'A' }, playerName: 'Player', signal: new AbortController().signal,
  };
}

test('NPC assessments reject provider error markers, unresolved answers, and the wrong answer primitive', async () => {
  const noul: Answer = { type: 'noul', noul: 0.8, confidence: null, provenance: 'fixture' };
  const score: Answer = { type: 'score', score: 3, legend: { 0: 'a', 1: 'b', 2: 'c', 3: 'd' }, probabilities: null, confidence: null, provenance: 'fixture' };
  const cases: { answers: Record<string, Answer>; errors: Record<string, string>; unresolvedQuestionIds: string[]; expected: string }[] = [
    { answers: { planned_1: noul }, errors: { planned_1: 'The judge refused.' }, unresolvedQuestionIds: [], expected: 'refusal' },
    { answers: { planned_1: noul }, errors: {}, unresolvedQuestionIds: ['planned_1'], expected: 'invalid_answers' },
    { answers: { planned_1: score }, errors: {}, unresolvedQuestionIds: [], expected: 'invalid_answers' },
    { answers: {}, errors: {}, unresolvedQuestionIds: [], expected: 'invalid_answers' },
  ];
  for (const item of cases) {
    const provider: DecisionProvider = {
      ...createMockProvider({ scenario: 'default' }),
      async evaluate(request): Promise<EvaluationResult> {
        return { requestId: request.requestId, provider: 'mock', requestedModel: null, returnedModel: null, ...item, durationMs: 0, transportAttempts: 1, inputTokens: null, outputTokens: null };
      },
    };
    await assert.rejects(adjudicateTurnProposal(adjudicationInput(provider)), (error: unknown) => error instanceof StagedError && error.type === item.expected);
  }
});

test('NPC proposal validation and saved-proposal reassessment remove collapsed details from the judge input', async () => {
  const hidden = '<details><summary>Private</summary>NPC-HIDDEN-CANARY</details>';
  const raw = proposal();
  raw.actions[0]!.method += ` ${hidden}`;
  raw.actions[0]!.boundedResult += ` ${hidden}`;
  raw.actions[0]!.failureStake.detail += ` ${hidden}`;
  const validated = validateTurnProposal(raw, context);
  assert.equal(validated.ok, true);
  assert.doesNotMatch(JSON.stringify(validated), /NPC-HIDDEN-CANARY/);
  const provider: DecisionProvider = {
    ...createMockProvider({ scenario: 'default' }),
    async evaluate(request): Promise<EvaluationResult> {
      assert.doesNotMatch(JSON.stringify(request), /NPC-HIDDEN-CANARY/);
      return {
        requestId: request.requestId, provider: 'mock', requestedModel: null, returnedModel: null,
        answers: { planned_1: { type: 'noul', noul: 0.5, confidence: null, provenance: 'fixture' } },
        errors: {}, unresolvedQuestionIds: [], durationMs: 0, transportAttempts: 1, inputTokens: null, outputTokens: null,
      };
    },
  };
  // Saved permits go directly to adjudication during Reassess, bypassing the
  // current tool argument validator. That path needs the same sanitation.
  const result = await adjudicateTurnProposal(adjudicationInput(provider, raw));
  assert.doesNotMatch(JSON.stringify(result.permit), /NPC-HIDDEN-CANARY/);
  assert.match(result.permit.actions[0]!.method, /wrench the satchel/);
});

test('a method entirely inside collapsed details is not a valid planned action', () => {
  const raw = proposal();
  raw.actions[0]!.method = '<details>Hidden method</details>';
  assert.equal(validateTurnProposal(raw, context).ok, false);
});

test('NPC discovery and mixed batches rebuild saved 0.7 snapshots from public identity and transcript only', async () => {
  for (const mixed of [false, true]) {
    const raw = proposal();
    raw.actions[0]!.family = 'detect_discover';
    raw.actions[0]!.method = 'looks at the visible latch';
    raw.actions[0]!.boundedResult = 'identifies how the latch opens';
    Object.assign(raw.actions[0]!, { authorialEvidence: 'PRIVATE-PROPOSAL-CANARY' });
    if (mixed) raw.actions.push({ ...proposal().actions[0]!, proposalId: 'p2' });
    let calls = 0;
    const provider: DecisionProvider = {
      ...createMockProvider({ scenario: 'default' }),
      async evaluate(request): Promise<EvaluationResult> {
        calls++;
        const serialized = JSON.stringify(request);
        assert.doesNotMatch(serialized, /PRIVATE-|HIDDEN-/);
        assert.match(serialized, /visible latch/);
        assert.match(serialized, /A public reply/);
        assert.match(serialized, /Character A/);
        assert.equal(Object.keys(request.questions).length, mixed ? 2 : 1);
        return {
          requestId: request.requestId, provider: 'mock', requestedModel: null, returnedModel: null,
          answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: 'noul', noul: 0.5, confidence: null, provenance: 'fixture' }])),
          errors: {}, unresolvedQuestionIds: [], durationMs: 0, transportAttempts: 1, inputTokens: null, outputTokens: null,
        };
      },
    };
    const data = adjudicationInput(provider, raw);
    const result = await adjudicateTurnProposal({
      ...data,
      snapshot: { ...data.snapshot, state: {
        latestInput: 'I inspect the visible latch. <details>HIDDEN-INPUT-CANARY</details>', playerActorId: 'player',
        actors: { 'npc-a': { name: 'Character A', control: 'npc', card: 'PRIVATE-CARD-CANARY', authorialCharacterContext: 'PRIVATE-AUTHOR-CANARY', judgedState: { trust: 'PRIVATE-METER-CANARY' } } },
        recentAcceptedMessages: [
          { actorId: 'npc-a', role: 'assistant', text: 'A public reply. <details>HIDDEN-REPLY-CANARY</details>', card: 'PRIVATE-MESSAGE-CANARY' },
          { actorId: 'author', role: 'author', text: 'PRIVATE-AUTHOR-MESSAGE-CANARY' },
        ],
        facts: { secret: 'PRIVATE-FACT-CANARY' }, secrets: ['PRIVATE-SECRET-CANARY'], meters: { trust: 'PRIVATE-METER-CANARY' },
        lore: [{ text: 'PRIVATE-LORE-CANARY', public: false }], authorEvidence: 'PRIVATE-EVIDENCE-CANARY',
      } },
    });
    assert.equal(calls, 1);
    assert.equal(result.permit.actions.length, mixed ? 2 : 1);
    assert.doesNotMatch(JSON.stringify(result.permit.snapshot), /PRIVATE-|HIDDEN-/);
    assert.doesNotMatch(JSON.stringify(result.permit.proposal), /PRIVATE-|HIDDEN-/);
  }
});
