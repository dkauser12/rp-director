/** Post-generation observation. The observer proposes factual deltas; only the reducer commits them. */
import type {
  Answer, CompactState, DecisionProvider, Json, ObservationOperation, ObservationRecord,
  ObservationRegistry, ObservationRequest, ProviderKind, Question, TurnPermit,
} from './types.ts';
import type { StructuredTransport } from './providers.ts';
import { ProviderError } from './providers.ts';
import { hash53 } from './identity.ts';

export interface ObservationProvider {
  readonly kind: ProviderKind | 'local';
  observe(request: ObservationRequest, signal: AbortSignal): Promise<ObservationRecord>;
}

const OP_NAMES = ['advance_time', 'set_known_location', 'transfer_item', 'set_condition', 'mark_fact_known', 'mark_secret_revealed'] as const;

interface RawOperation {
  op: string;
  seconds?: unknown;
  quality?: unknown;
  actorId?: unknown;
  actorIds?: unknown;
  placeId?: unknown;
  status?: unknown;
  itemId?: unknown;
  fromActorId?: unknown;
  toActorId?: unknown;
  conditionId?: unknown;
  active?: unknown;
  factId?: unknown;
  secretId?: unknown;
}

interface RawObservation {
  schemaVersion?: unknown;
  requestId?: unknown;
  attemptId?: unknown;
  variantId?: unknown;
  baseCursor?: unknown;
  cursorAfter?: unknown;
  stateRevision?: unknown;
  realizedResolutionIds?: unknown;
  operations?: unknown;
  unresolved?: unknown;
}

type OperationBody<T> = T extends { operationId: string } ? Omit<T, 'operationId'> : never;
type ObservationOperationBody = OperationBody<ObservationOperation>;

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stableOperationId(variantId: string, index: number, operation: ObservationOperationBody): string {
  return `obsop_${hash53(`${variantId}|${index}|${JSON.stringify(operation)}`)}`;
}

function dedupeSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function buildObservationRegistry(input: {
  state: CompactState;
  actorIds: string[];
  expectedResolutionIds: string[];
  permit: TurnPermit | null;
}): ObservationRegistry {
  const placeIds = Object.values(input.state.positions).flatMap(position => [position.placeId, position.lastKnownPlaceId]).filter((x): x is string => typeof x === 'string' && x.length > 0);
  const conditionIds = Object.values(input.state.conditions).flatMap(conditions => Object.keys(conditions));
  // These are Director-owned bounded condition labels, not free-form model output.
  conditionIds.push('injured', 'restrained', 'unconscious', 'hidden', 'exposed');
  const factIds = [...input.expectedResolutionIds];
  for (const permitAction of input.permit?.actions ?? []) factIds.push(`fact:${permitAction.resolutionId}`);
  return {
    actorIds: dedupeSorted(input.actorIds),
    placeIds: dedupeSorted(placeIds),
    itemIds: dedupeSorted(Object.keys(input.state.itemOwners)),
    conditionIds: dedupeSorted(conditionIds),
    factIds: dedupeSorted(factIds),
    secretIds: dedupeSorted(Object.keys(input.state.revealedSecrets)),
  };
}

type ObservationMeta = {
  providerKind: ProviderKind | 'local';
  requestedModel: string | null;
  returnedModel: string | null;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
};

/** Validates identity, registry ownership, bounds, and conflicting operations. */
export function validateObservationPayload(raw: unknown, request: ObservationRequest, meta: ObservationMeta): ObservationRecord {
  const root = asObject(raw) as RawObservation | null;
  if (!root || root.schemaVersion !== 1 || !Array.isArray(root.realizedResolutionIds) || !Array.isArray(root.operations) || !Array.isArray(root.unresolved)) {
    throw new Error('observer returned a malformed payload');
  }
  if (root.requestId !== request.requestId || root.attemptId !== request.attemptId || root.variantId !== request.variantId || root.baseCursor !== request.baseCursor || root.cursorAfter !== request.cursorAfter || root.stateRevision !== request.stateRevision) {
    throw new Error('observer payload identity does not match the active variant and state revision');
  }
  if (root.realizedResolutionIds.some(id => typeof id !== 'string') || root.unresolved.some(item => typeof item !== 'string')) throw new Error('observer payload contains non-string ids');
  const expected = new Set(request.expectedResolutionIds);
  const realized = dedupeSorted(root.realizedResolutionIds as string[]);
  for (const id of realized) if (!expected.has(id)) throw new Error(`observer claimed unregistered resolution ${id}`);

  const actors = new Set(request.registry.actorIds);
  const places = new Set(request.registry.placeIds);
  const items = new Set(request.registry.itemIds);
  const conditions = new Set(request.registry.conditionIds);
  const facts = new Set(request.registry.factIds);
  const secrets = new Set(request.registry.secretIds);
  const operations: ObservationOperation[] = [];
  const unresolved = [...root.unresolved as string[]];
  const targets = new Set<string>();
  for (let index = 0; index < root.operations.length; index++) {
    const operation = asObject(root.operations[index]) as RawOperation | null;
    if (!operation || typeof operation.op !== 'string' || !OP_NAMES.includes(operation.op as (typeof OP_NAMES)[number])) {
      unresolved.push(`operation ${index + 1}: unknown operation`);
      continue;
    }
    let clean: ObservationOperationBody | null = null;
    let key = '';
    switch (operation.op) {
      case 'advance_time': {
        if (!Number.isInteger(operation.seconds) || Number(operation.seconds) < 1 || Number(operation.seconds) > 86400 || !['exact', 'estimated'].includes(String(operation.quality))) {
          unresolved.push(`operation ${index + 1}: invalid time delta`); break;
        }
        clean = { op: 'advance_time', seconds: Number(operation.seconds), quality: operation.quality as 'exact' | 'estimated' };
        key = 'time';
        break;
      }
      case 'set_known_location': {
        if (typeof operation.actorId !== 'string' || !actors.has(operation.actorId) || (operation.placeId !== null && (typeof operation.placeId !== 'string' || !places.has(operation.placeId))) || !['known', 'unknown', 'in_transit'].includes(String(operation.status))) {
          unresolved.push(`operation ${index + 1}: unregistered actor or place`); break;
        }
        clean = { op: 'set_known_location', actorId: operation.actorId, placeId: operation.placeId as string | null, status: operation.status as 'known' | 'unknown' | 'in_transit' };
        key = `location:${operation.actorId}`;
        break;
      }
      case 'transfer_item': {
        if (typeof operation.itemId !== 'string' || !items.has(operation.itemId) || (operation.fromActorId !== null && (typeof operation.fromActorId !== 'string' || !actors.has(operation.fromActorId))) || (operation.toActorId !== null && (typeof operation.toActorId !== 'string' || !actors.has(operation.toActorId)))) {
          unresolved.push(`operation ${index + 1}: unregistered item or actor`); break;
        }
        if ((request.priorState.itemOwners[operation.itemId] ?? null) !== operation.fromActorId) {
          unresolved.push(`operation ${index + 1}: item owner precondition did not match`); break;
        }
        clean = { op: 'transfer_item', itemId: operation.itemId, fromActorId: operation.fromActorId as string | null, toActorId: operation.toActorId as string | null };
        key = `item:${operation.itemId}`;
        break;
      }
      case 'set_condition': {
        if (typeof operation.actorId !== 'string' || !actors.has(operation.actorId) || typeof operation.conditionId !== 'string' || !conditions.has(operation.conditionId) || typeof operation.active !== 'boolean') {
          unresolved.push(`operation ${index + 1}: unregistered condition or actor`); break;
        }
        clean = { op: 'set_condition', actorId: operation.actorId, conditionId: operation.conditionId, active: operation.active };
        key = `condition:${operation.actorId}:${operation.conditionId}`;
        break;
      }
      case 'mark_fact_known': {
        if (typeof operation.actorId !== 'string' || !actors.has(operation.actorId) || typeof operation.factId !== 'string' || !facts.has(operation.factId)) {
          unresolved.push(`operation ${index + 1}: unregistered fact or actor`); break;
        }
        clean = { op: 'mark_fact_known', actorId: operation.actorId, factId: operation.factId };
        key = `fact:${operation.actorId}:${operation.factId}`;
        break;
      }
      case 'mark_secret_revealed': {
        if (typeof operation.secretId !== 'string' || !secrets.has(operation.secretId) || !Array.isArray(operation.actorIds) || operation.actorIds.some(id => typeof id !== 'string' || !actors.has(id))) {
          unresolved.push(`operation ${index + 1}: unregistered secret or actor`); break;
        }
        const actorIds = dedupeSorted(operation.actorIds as string[]);
        clean = { op: 'mark_secret_revealed', secretId: operation.secretId, actorIds };
        key = `secret:${operation.secretId}`;
        break;
      }
    }
    if (!clean) continue;
    if (targets.has(key)) throw new Error(`observer returned conflicting operations for ${key}`);
    targets.add(key);
    operations.push({ ...clean, operationId: stableOperationId(request.variantId, index, clean) } as ObservationOperation);
  }
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    attemptId: request.attemptId,
    variantId: request.variantId,
    baseCursor: request.baseCursor,
    cursorAfter: request.cursorAfter,
    stateRevision: request.stateRevision,
    realizedResolutionIds: realized,
    operations,
    unresolved: dedupeSorted(unresolved),
    ...meta,
  };
}

function barePayload(request: ObservationRequest, realizedResolutionIds: string[], unresolved: string[] = []): RawObservation {
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    attemptId: request.attemptId,
    variantId: request.variantId,
    baseCursor: request.baseCursor,
    cursorAfter: request.cursorAfter,
    stateRevision: request.stateRevision,
    realizedResolutionIds,
    operations: [],
    unresolved,
  };
}

/** Mock/rules mode: deterministic harness semantics, clearly labelled local. */
export function createLocalObservationProvider(): ObservationProvider {
  return {
    kind: 'local',
    async observe(request): Promise<ObservationRecord> {
      const realized = request.acceptedSpan.text.trim() ? request.expectedResolutionIds : [];
      return validateObservationPayload(barePayload(request, realized), request, {
        providerKind: 'local', requestedModel: null, returnedModel: null, durationMs: 0, inputTokens: null, outputTokens: null,
      });
    },
  };
}

function observerQuestion(id: string): Question {
  return {
    type: 'choice',
    instructions: `Using only state.acceptedSpan, decide whether the final prose actually realizes the frozen ruling identified by ${id}. A permit or ruling is not proof. Hypothetical, attempted, negated, interrupted, merely planned, or ambiguous events are not realized.`,
    criteria: {
      realized: 'The accepted prose explicitly and presently realizes the bounded ruling.',
      not_realized: 'The accepted prose explicitly shows that the bounded ruling is not realized.',
      unclear: 'The prose does not establish the result clearly enough.',
    },
  };
}

/** Jev and other decision-only providers: bounded entailment registry, no free-form deltas. */
export function createDecisionObservationProvider(provider: DecisionProvider): ObservationProvider {
  return {
    kind: provider.kind,
    async observe(request, signal): Promise<ObservationRecord> {
      if (request.expectedResolutionIds.length === 0) return createLocalObservationProvider().observe(request, signal);
      const questions: Record<string, Question> = {};
      for (let i = 0; i < request.expectedResolutionIds.length; i++) questions[`realized_${i + 1}`] = observerQuestion(request.expectedResolutionIds[i]!);
      const snapshotState: Json = {
        priorState: request.priorState as unknown as Json,
        acceptedSpan: request.acceptedSpan as unknown as Json,
        expectedRulings: request.expectedRulings as unknown as Json,
      };
      const result = await provider.evaluate({
        requestId: request.requestId,
        phase: 'observe',
        snapshot: {
          chatId: '', cursorBefore: request.cursorAfter, stateRevision: request.stateRevision, scopeId: 'shared-public',
          profileRevision: '', catalogRevision: '', actorBindingRevision: request.registry.actorIds.join(','), state: snapshotState,
        },
        questions,
      }, signal);
      const realized: string[] = [];
      const unresolved: string[] = [];
      for (let i = 0; i < request.expectedResolutionIds.length; i++) {
        const id = request.expectedResolutionIds[i]!;
        const answer = result.answers[`realized_${i + 1}`] as Answer | undefined;
        if (answer?.type === 'choice' && answer.choice === 'realized') realized.push(id);
        else if (!answer || answer.type !== 'choice' || answer.choice === 'unclear') unresolved.push(`resolution ${id}: ${result.errors[`realized_${i + 1}`] ?? 'observer was unclear'}`);
      }
      return validateObservationPayload(barePayload(request, realized, unresolved), request, {
        providerKind: result.provider, requestedModel: result.requestedModel, returnedModel: result.returnedModel,
        durationMs: result.durationMs, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      });
    },
  };
}

function observerSchema(): Json {
  const nullableString = { type: ['string', 'null'] };
  return {
    type: 'object', additionalProperties: false,
    properties: {
      schemaVersion: { type: 'integer', enum: [1] }, requestId: { type: 'string' }, attemptId: { type: 'string' }, variantId: { type: 'string' },
      baseCursor: { type: 'string' }, cursorAfter: { type: 'string' }, stateRevision: { type: 'integer' },
      realizedResolutionIds: { type: 'array', items: { type: 'string' } },
      operations: {
        type: 'array', maxItems: 12, items: {
          type: 'object', additionalProperties: false,
          properties: {
            op: { type: 'string', enum: [...OP_NAMES] }, seconds: { type: ['integer', 'null'] }, quality: { type: ['string', 'null'], enum: ['exact', 'estimated', null] },
            actorId: nullableString, actorIds: { type: ['array', 'null'], items: { type: 'string' } }, placeId: nullableString,
            status: { type: ['string', 'null'], enum: ['known', 'unknown', 'in_transit', null] }, itemId: nullableString,
            fromActorId: nullableString, toActorId: nullableString, conditionId: nullableString, active: { type: ['boolean', 'null'] },
            factId: nullableString, secretId: nullableString,
          },
          required: ['op', 'seconds', 'quality', 'actorId', 'actorIds', 'placeId', 'status', 'itemId', 'fromActorId', 'toActorId', 'conditionId', 'active', 'factId', 'secretId'],
        },
      },
      unresolved: { type: 'array', items: { type: 'string' } },
    },
    required: ['schemaVersion', 'requestId', 'attemptId', 'variantId', 'baseCursor', 'cursorAfter', 'stateRevision', 'realizedResolutionIds', 'operations', 'unresolved'],
  };
}

/** Structured observer can propose only operations whose IDs are in the supplied registry. */
export function createStructuredObservationProvider(input: { transport: StructuredTransport; model: string | null; timeoutMs: number }): ObservationProvider {
  return {
    kind: 'structured',
    async observe(request, signal): Promise<ObservationRecord> {
      const started = performance.now();
      const combined = AbortSignal.any([signal, AbortSignal.timeout(input.timeoutMs)]);
      const system = 'Observe only the accepted final assistant span. Return factual deltas from the supplied registry. A ruling or permit is not proof. Do not record plans, attempts, hypotheticals, negated events, inner feelings, inferred consent, trust, love, permanent attitude, or facts outside the registry. Unknown or ambiguous facts go in unresolved. Copy every identity field exactly.';
      let transported;
      try {
        transported = await input.transport({
          model: input.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: JSON.stringify(request) },
          ],
          json_schema: { name: 'rp_director_observation', strict: true, schema: observerSchema() },
        }, combined);
      } catch (error) {
        if (combined.aborted) throw new ProviderError(signal.aborted ? 'aborted' : 'timeout', signal.aborted ? 'observation was cancelled' : 'observation exceeded its deadline');
        throw error;
      }
      let raw = transported.content;
      if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch { throw new ProviderError('malformed', 'observer returned invalid JSON'); }
      }
      return validateObservationPayload(raw, request, {
        providerKind: 'structured', requestedModel: input.model, returnedModel: transported.model,
        durationMs: performance.now() - started, inputTokens: transported.usage?.input ?? null, outputTokens: transported.usage?.output ?? null,
      });
    },
  };
}
