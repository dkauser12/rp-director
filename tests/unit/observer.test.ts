import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildObservationRegistry, createDecisionObservationProvider, validateObservationPayload } from '../../src/observer.ts';
import { emptyState } from '../../src/state.ts';
import type { DecisionProvider, ObservationRequest } from '../../src/types.ts';

function request(): ObservationRequest {
  const state = emptyState();
  state.positions.a = { status: 'known', placeId: 'kitchen', lastKnownPlaceId: 'kitchen', offstage: false };
  state.itemOwners.key = 'a';
  const registry = buildObservationRegistry({ state, actorIds: ['a', 'b'], expectedResolutionIds: ['r1'], permit: null });
  return {
    schemaVersion: 1, requestId: 'oq1', attemptId: 'a1', variantId: 'v1', baseCursor: 'c0', cursorAfter: 'c1', stateRevision: 0,
    acceptedSpan: { id: 'span:v1', actorId: 'a', role: 'assistant', text: 'A crosses the kitchen and gives B the key.', accepted: true },
    expectedResolutionIds: ['r1'], expectedRulings: [{ resolutionId: 'r1', actingActorId: 'a', boundedResult: 'the key changes hands', outcome: 'achieved', instruction: 'Show the key changing hands.' }], permit: null, priorState: state, registry,
  };
}

const meta = { providerKind: 'structured' as const, requestedModel: 'm', returnedModel: 'm', durationMs: 3, inputTokens: 10, outputTokens: 5 };

test('observer accepts only registered operations and assigns deterministic operation ids', () => {
  const req = request();
  const raw = {
    schemaVersion: 1, requestId: 'oq1', attemptId: 'a1', variantId: 'v1', baseCursor: 'c0', cursorAfter: 'c1', stateRevision: 0,
    realizedResolutionIds: ['r1'], unresolved: [], operations: [
      { op: 'advance_time', seconds: 60, quality: 'estimated' },
      { op: 'transfer_item', itemId: 'key', fromActorId: 'a', toActorId: 'b' },
      { op: 'set_condition', actorId: 'b', conditionId: 'injured', active: true },
    ],
  };
  const first = validateObservationPayload(raw, req, meta);
  const second = validateObservationPayload(raw, req, meta);
  assert.equal(first.operations.length, 3);
  assert.deepEqual(first.operations.map(op => op.operationId), second.operations.map(op => op.operationId));
  assert.deepEqual(first.realizedResolutionIds, ['r1']);
});

test('unknown registry values remain unresolved instead of becoming state', () => {
  const req = request();
  const result = validateObservationPayload({
    schemaVersion: 1, requestId: 'oq1', attemptId: 'a1', variantId: 'v1', baseCursor: 'c0', cursorAfter: 'c1', stateRevision: 0,
    realizedResolutionIds: [], unresolved: [], operations: [
      { op: 'transfer_item', itemId: 'invented-crown', fromActorId: 'a', toActorId: 'b' },
      { op: 'set_known_location', actorId: 'a', placeId: 'invented-moon', status: 'known' },
    ],
  }, req, meta);
  assert.deepEqual(result.operations, []);
  assert.equal(result.unresolved.length, 2);
});

test('observer fails closed on stale identity, unregistered rulings, and conflicting operations', () => {
  const req = request();
  const base = {
    schemaVersion: 1, requestId: 'oq1', attemptId: 'a1', variantId: 'v1', baseCursor: 'c0', cursorAfter: 'c1', stateRevision: 0,
    realizedResolutionIds: ['r1'], unresolved: [], operations: [],
  };
  assert.throws(() => validateObservationPayload({ ...base, cursorAfter: 'other' }, req, meta), /identity/);
  assert.throws(() => validateObservationPayload({ ...base, realizedResolutionIds: ['invented'] }, req, meta), /unregistered resolution/);
  assert.throws(() => validateObservationPayload({ ...base, operations: [
    { op: 'set_condition', actorId: 'b', conditionId: 'injured', active: true },
    { op: 'set_condition', actorId: 'b', conditionId: 'injured', active: false },
  ] }, req, meta), /conflicting operations/);
});

test('bounded Jev observer makes no network call when a native bypass has no rulings to verify', async () => {
  let calls = 0;
  const decisionProvider: DecisionProvider = {
    kind: 'jev',
    capabilities: { primitives: ['choice'], distributions: 'native', confidence: 'native_distribution_statistic', structuredOutput: 'native_typed', independentSharedStateBatch: true, maxQuestions: null, cancellation: 'abort_signal', usageReporting: true },
    async evaluate() { calls += 1; throw new Error('must not be called'); },
  };
  const req = request();
  req.expectedResolutionIds = [];
  req.expectedRulings = [];
  req.registry = buildObservationRegistry({ state: req.priorState, actorIds: ['a', 'b'], expectedResolutionIds: [], permit: null });
  const observation = await createDecisionObservationProvider(decisionProvider).observe(req, new AbortController().signal);
  assert.equal(calls, 0);
  assert.equal(observation.providerKind, 'local');
  assert.deepEqual(observation.realizedResolutionIds, []);
});
