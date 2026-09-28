import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjudicateTurnProposal, validateTurnProposal } from '../../src/director-tool.ts';
import { profileById } from '../../src/profiles.ts';
import type { DecisionProvider, TurnProposal } from '../../src/types.ts';
import { createMockProvider } from '../../src/providers.ts';

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
