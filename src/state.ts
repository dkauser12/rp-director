/**
 * Lifecycle reducer (plan §7–§8): pure functions over the per-chat record.
 *
 * Every mutation of the record goes through `applyEvent`. The reducer never
 * touches the host; the controller feeds it host events and persists the
 * result. Identities: actionId (declared action), resolutionId (frozen
 * decision), attemptId (one writer generation), variantId (one host message
 * variant), cursor (accepted-prefix fingerprint).
 */
import type {
  ActionSpec, ActorBinding, CompactState, DirectorChatRecord, FrozenResolution, GenerationAttempt,
  GenerationType, InspectorEntry, ObservationOperation, ObservationRecord, RegisteredEffect, TurnPermit, VariantRecord,
} from './types.ts';
import { defOfResolution, effectsFor, gainVariableId, instructionForResolution, tierForResolution } from './resolver.ts';

export const INSPECTOR_LIMIT = 200;

export function emptyState(): CompactState {
  return {
    revision: 0,
    variables: {},
    settledGains: {},
    unresolvedVariableIds: [],
    elapsedSeconds: 0,
    timeQuality: 'unresolved',
    sceneId: 1,
    sceneReplyCount: 0,
    positions: {},
    notifiedDeadlineIds: [],
    acceptedResolutionIds: [],
    acceptedPermitIds: [],
    itemOwners: {},
    conditions: {},
    knownFacts: {},
    revealedSecrets: {},
    lastObservedCursor: '',
    trackingStatus: 'current',
  };
}

export function newRecord(seedId: string, profileRevision: string): DirectorChatRecord {
  return {
    schemaVersion: 1,
    seedId,
    actors: {},
    actions: {},
    resolutions: {},
    permits: {},
    attempts: {},
    variants: {},
    checkpoints: {},
    appliedOperationIds: [],
    pending: null,
    projection: { cursor: null, state: emptyState(), status: 'unknown', reason: 'no checkpoint yet' },
    inspector: [],
    profileRevision,
  };
}

/** Loads a record from untrusted metadata, filling defaults; never throws. */
export function normalizeRecord(raw: unknown, seedId: string, profileRevision: string): DirectorChatRecord {
  const base = newRecord(seedId, profileRevision);
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<DirectorChatRecord>;
  if (r.schemaVersion !== 1) return base;
  const obj = <T>(v: unknown, fallback: T): T => (v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : fallback);
  const normalized: DirectorChatRecord = {
    schemaVersion: 1,
    seedId: typeof r.seedId === 'string' && r.seedId ? r.seedId : seedId,
    actors: obj(r.actors, {}),
    actions: obj(r.actions, {}),
    resolutions: obj(r.resolutions, {}),
    permits: obj(r.permits, {}),
    attempts: obj(r.attempts, {}),
    variants: obj(r.variants, {}),
    checkpoints: obj(r.checkpoints, {}),
    appliedOperationIds: Array.isArray(r.appliedOperationIds) ? r.appliedOperationIds.filter(x => typeof x === 'string') : [],
    pending: obj(r.pending, null),
    projection: r.projection && typeof r.projection === 'object' ? { ...base.projection, ...r.projection, state: { ...emptyState(), ...obj(r.projection.state, {}), settledGains: obj(r.projection.state?.settledGains, {}), itemOwners: obj(r.projection.state?.itemOwners, {}), conditions: obj(r.projection.state?.conditions, {}), knownFacts: obj(r.projection.state?.knownFacts, {}), revealedSecrets: obj(r.projection.state?.revealedSecrets, {}) } } : base.projection,
    inspector: Array.isArray(r.inspector) ? r.inspector.slice(-INSPECTOR_LIMIT) : [],
    profileRevision: typeof r.profileRevision === 'string' ? r.profileRevision : profileRevision,
  };
  for (const checkpoint of Object.values(normalized.checkpoints)) {
    checkpoint.stateAfter = { ...emptyState(), ...checkpoint.stateAfter, settledGains: obj(checkpoint.stateAfter?.settledGains, {}), itemOwners: obj(checkpoint.stateAfter?.itemOwners, {}), conditions: obj(checkpoint.stateAfter?.conditions, {}), knownFacts: obj(checkpoint.stateAfter?.knownFacts, {}), revealedSecrets: obj(checkpoint.stateAfter?.revealedSecrets, {}) };
    hydrateFrozenSettlements(checkpoint.stateAfter, normalized.resolutions);
  }
  hydrateFrozenSettlements(normalized.projection.state, normalized.resolutions);
  return normalized;
}

/** Migrates old accepted records into frozen settlements without consulting today's policy table. */
function hydrateFrozenSettlements(state: CompactState, resolutions: Record<string, FrozenResolution>): void {
  state.settledGains = state.settledGains && typeof state.settledGains === 'object' ? state.settledGains : {};
  for (const resolutionId of state.acceptedResolutionIds ?? []) {
    const resolution = resolutions[resolutionId];
    if (!resolution || resolution.status !== 'accepted') continue;
    const legacyTier = tierForResolution(resolution);
    const legacyFinal = resolution.outcomeFinal === undefined && resolution.outcomeInstruction === undefined && legacyTier === 'achieved';
    if (resolution.outcomeFinal !== true && !legacyFinal) continue;
    const def = defOfResolution(resolution) ?? (legacyFinal
      ? { name: resolution.outcome, instruction: instructionForResolution(resolution), records: 'achieved', final: true }
      : null);
    if (!def) continue;
    const scope = resolution.action.identityVersion === 2 ? (resolution.action.resolutionScope ?? 'attempt') : 'persistent';
    if (scope === 'attempt') continue;
    const variableId = gainVariableId(resolution.action);
    if (!state.settledGains[variableId]) {
      state.settledGains[variableId] = {
        variableId,
        resolutionId,
        outcome: def,
        scope,
        sceneId: scope === 'scene' ? (resolution.action.sceneId ?? null) : null,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type DirectorEvent =
  | { type: 'bind_actor'; binding: ActorBinding }
  | { type: 'prepare'; resolution: FrozenResolution | null; action: ActionSpec | null; attemptId: string; actorId: string | null; epoch: number; composerText: string; now: number }
  | { type: 'bind'; attemptId: string; cursorBefore: string; epoch: number; injectedText: string; toolOffered?: boolean }
  | { type: 'tool_result'; attemptId: string; permit: TurnPermit | null; status: 'permitted' | 'failed' | 'malformed'; error: string | null }
  | { type: 'store_permit'; permit: TurnPermit }
  | { type: 'store_resolution'; resolution: FrozenResolution }
  | { type: 'regeneration_attempt'; attemptId: string; resolutionId: string | null; permitId?: string | null; cursorBefore: string; epoch: number; generationType: GenerationType; actorId: string | null; injectedText: string; unadjudicated: boolean; now: number }
  | { type: 'completed'; attemptId: string; epoch: number; operationId: string; variantId: string; hostMessageRef: number | null; hostVariantRef: number | null; cursorAfter: string; now: number; actorId?: string | null; observerRequired?: boolean }
  | { type: 'observation_ready'; attemptId: string; variantId: string; observation: ObservationRecord }
  | { type: 'observation_failed'; attemptId: string; variantId: string; error: string }
  | { type: 'retry_observation'; attemptId: string; variantId: string }
  | { type: 'commit_observation'; variantId: string; operationId: string; now: number }
  | { type: 'accept'; attemptId: string; operationId: string; now: number }
  | { type: 'reject'; attemptId: string }
  | { type: 'cancel'; attemptId: string | null; epoch: number; reason: string }
  | { type: 'abort_epoch'; epoch: number; reason: string }
  | { type: 'select_variant'; variantId: string | null; cursorAfter: string; chain: string[] }
  | { type: 'head_changed'; cursor: string; chain: string[]; reason: 'edit' | 'delete' | 'load' | 'branch' | 'continue' | 'unknown' }
  | { type: 'reroll'; previousResolutionId: string; resolution: FrozenResolution; now: number }
  | { type: 'invalidate_prepared'; reason: string; onlyUnbound: boolean; profileRevision: string | null }
  | { type: 'set_baseline'; cursor: string; state: CompactState; reason: string }
  | { type: 'start_scene'; cursor: string; reason: string }
  /** A user (or otherwise untracked) message extends the accepted prefix without changing tracked state. */
  | { type: 'extend_checkpoint'; cursor: string; parentCursor: string }
  | { type: 'inspect'; entry: InspectorEntry };

export interface ApplyResult {
  record: DirectorChatRecord;
  notices: string[];
  changed: boolean;
}

function clone<T>(x: T): T {
  return structuredClone(x);
}

function predecessorState(record: DirectorChatRecord, cursorBefore: string | null): { state: CompactState; known: boolean } {
  if (cursorBefore) {
    const cp = record.checkpoints[cursorBefore];
    if (cp) return { state: clone(cp.stateAfter), known: true };
    if (record.projection.cursor === cursorBefore && record.projection.status !== 'unknown') return { state: clone(record.projection.state), known: true };
  }
  return { state: clone(record.projection.state), known: false };
}

/** Applies registered effects; unknown ops are refused, never guessed. */
export function applyEffects(state: CompactState, effects: RegisteredEffect[]): { state: CompactState; refused: string[] } {
  const next = clone(state);
  const refused: string[] = [];
  for (const effect of effects) {
    switch (effect.op) {
      case 'set_enum':
        next.variables[effect.variableId] = effect.value;
        break;
      case 'set_bounded_value':
        if (Number.isFinite(effect.value)) next.variables[effect.variableId] = effect.value;
        else refused.push(`set_bounded_value ${effect.variableId}: nonfinite`);
        break;
      case 'apply_named_delta':
      case 'advance_time':
      case 'set_known_location':
        refused.push(`${effect.op}: not enabled before milestone 4`);
        break;
      default:
        refused.push(`unknown effect ${(effect as { op: string }).op}`);
    }
  }
  return { state: next, refused };
}

/** Applies already-validated observer operations. This is the only new-state writer in the live v2 flow. */
export function applyObservationOperations(state: CompactState, operations: ObservationOperation[]): CompactState {
  const next = clone(state);
  for (const operation of operations) {
    switch (operation.op) {
      case 'advance_time':
        next.elapsedSeconds += operation.seconds;
        next.timeQuality = operation.quality;
        break;
      case 'set_known_location': {
        const previous = next.positions[operation.actorId];
        next.positions[operation.actorId] = {
          status: operation.status,
          placeId: operation.placeId,
          lastKnownPlaceId: operation.status === 'known' ? operation.placeId : (previous?.placeId ?? previous?.lastKnownPlaceId ?? null),
          offstage: previous?.offstage ?? false,
        };
        break;
      }
      case 'transfer_item':
        next.itemOwners[operation.itemId] = operation.toActorId;
        break;
      case 'set_condition':
        next.conditions[operation.actorId] = { ...(next.conditions[operation.actorId] ?? {}), [operation.conditionId]: operation.active };
        break;
      case 'mark_fact_known':
        next.knownFacts[operation.actorId] = [...new Set([...(next.knownFacts[operation.actorId] ?? []), operation.factId])].sort();
        break;
      case 'mark_secret_revealed':
        next.revealedSecrets[operation.secretId] = [...new Set([...(next.revealedSecrets[operation.secretId] ?? []), ...operation.actorIds])].sort();
        break;
    }
  }
  return next;
}

export function applyEvent(input: DirectorChatRecord, event: DirectorEvent): ApplyResult {
  const record = clone(input);
  const notices: string[] = [];
  const done = (changed = true): ApplyResult => ({ record, notices, changed });
  const ignore = (why: string): ApplyResult => { notices.push(why); return { record: input, notices, changed: false }; };

  switch (event.type) {
    case 'bind_actor': {
      record.actors[event.binding.actorId] = { ...event.binding };
      return done();
    }

    case 'prepare': {
      if (record.pending) {
        const prev = record.attempts[record.pending.attemptId];
        if (prev && (prev.status === 'prepared' || prev.status === 'writing')) prev.status = 'cancelled';
        notices.push(`replaced pending preparation ${record.pending.attemptId}`);
      }
      if (event.action) record.actions[event.action.actionId] = clone(event.action);
      if (event.resolution) record.resolutions[event.resolution.resolutionId] = clone(event.resolution);
      const attempt: GenerationAttempt = {
        attemptId: event.attemptId,
        resolutionId: event.resolution?.resolutionId ?? null,
        permitId: null,
        actorId: event.actorId,
        cursorBefore: null,
        status: 'prepared',
        generationType: 'normal',
        hostMessageRef: null,
        hostVariantRef: null,
        variantId: null,
        injectedText: '',
        epoch: event.epoch,
        unadjudicated: false,
        toolStatus: 'not_offered',
        toolError: null,
        createdAt: event.now,
      };
      record.attempts[attempt.attemptId] = attempt;
      record.pending = { attemptId: attempt.attemptId, resolutionId: attempt.resolutionId, actorId: event.actorId, epoch: event.epoch, composerText: event.composerText, createdAt: event.now };
      return done();
    }

    case 'bind': {
      const pending = record.pending;
      if (!pending || pending.attemptId !== event.attemptId) return ignore(`bind ignored: no pending attempt ${event.attemptId}`);
      if (pending.epoch !== event.epoch) return ignore(`bind ignored: epoch ${event.epoch} does not match pending epoch ${pending.epoch}`);
      const attempt = record.attempts[event.attemptId];
      if (!attempt) return ignore('bind ignored: attempt record missing');
      attempt.cursorBefore = event.cursorBefore;
      attempt.status = 'writing';
      attempt.injectedText = event.injectedText;
      attempt.toolStatus = event.toolOffered ? 'offered' : 'not_offered';
      if (attempt.resolutionId) {
        const res = record.resolutions[attempt.resolutionId];
        if (res) {
          if (res.cursorBefore === null) res.cursorBefore = event.cursorBefore;
          else if (res.cursorBefore !== event.cursorBefore) {
            res.status = 'invalidated';
            attempt.resolutionId = null;
            attempt.unadjudicated = true;
            notices.push(`resolution ${res.resolutionId} was frozen for a different prefix and is invalidated`);
          }
        }
      }
      record.pending = null;
      return done();
    }

    case 'store_permit': {
      record.permits[event.permit.permitId] = clone(event.permit);
      return done();
    }

    case 'store_resolution': {
      record.actions[event.resolution.actionId] = clone(event.resolution.action);
      record.resolutions[event.resolution.resolutionId] = clone(event.resolution);
      return done();
    }

    case 'tool_result': {
      const attempt = record.attempts[event.attemptId];
      if (!attempt || attempt.status !== 'writing') return ignore(`tool result for inactive attempt ${event.attemptId} ignored`);
      attempt.toolStatus = event.status;
      attempt.toolError = event.error;
      if (event.permit) {
        if (event.permit.attemptId !== attempt.attemptId || event.permit.baseCursor !== attempt.cursorBefore) return ignore('tool permit identity did not match the active attempt');
        record.permits[event.permit.permitId] = clone(event.permit);
        attempt.permitId = event.permit.permitId;
      }
      return done();
    }

    case 'regeneration_attempt': {
      if (record.attempts[event.attemptId]) return ignore(`attempt ${event.attemptId} already exists`);
      record.attempts[event.attemptId] = {
        attemptId: event.attemptId,
        resolutionId: event.resolutionId,
        permitId: event.permitId ?? null,
        actorId: event.actorId,
        cursorBefore: event.cursorBefore,
        status: 'writing',
        generationType: event.generationType,
        hostMessageRef: null,
        hostVariantRef: null,
        variantId: null,
        injectedText: event.injectedText,
        epoch: event.epoch,
        unadjudicated: event.unadjudicated,
        toolStatus: event.permitId ? 'reused' : 'not_offered',
        toolError: null,
        createdAt: event.now,
      };
      return done();
    }

    case 'completed': {
      if (record.appliedOperationIds.includes(event.operationId)) return ignore(`duplicate completion ${event.operationId} ignored`);
      const attempt = record.attempts[event.attemptId];
      if (!attempt) return ignore(`completion for unknown attempt ${event.attemptId} ignored`);
      if (attempt.epoch !== event.epoch) return ignore(`stale completion for attempt ${event.attemptId} from epoch ${attempt.epoch} rejected`);
      if (attempt.status !== 'writing') return ignore(`completion for attempt ${event.attemptId} in status ${attempt.status} ignored`);
      record.appliedOperationIds.push(event.operationId);
      attempt.hostMessageRef = event.hostMessageRef;
      attempt.hostVariantRef = event.hostVariantRef;
      attempt.variantId = event.variantId;
      if (attempt.actorId === null && event.actorId) attempt.actorId = event.actorId;
      const resolution = attempt.resolutionId ? record.resolutions[attempt.resolutionId] ?? null : null;
      const needsAcceptance = Boolean(resolution);
      const variant: VariantRecord = {
        variantId: event.variantId,
        attemptId: attempt.attemptId,
        resolutionId: resolution?.resolutionId ?? null,
        permitId: attempt.permitId ?? null,
        actorId: attempt.actorId,
        cursorBefore: attempt.cursorBefore,
        cursorAfter: event.cursorAfter,
        acceptance: (needsAcceptance || event.observerRequired) ? 'pending' : 'auto',
        observerStatus: event.observerRequired ? 'pending' : 'not_required',
        observation: null,
        observerError: null,
      };
      record.variants[variant.variantId] = variant;
      if (event.observerRequired) {
        attempt.status = 'observing';
        const pred = predecessorState(record, attempt.cursorBefore);
        record.projection = { cursor: event.cursorAfter, state: pred.state, status: 'provisional', reason: `observing ${attempt.attemptId}` };
        return done();
      }
      if (needsAcceptance) {
        attempt.status = 'provisional';
        const pred = predecessorState(record, attempt.cursorBefore);
        record.projection = { cursor: event.cursorAfter, state: pred.state, status: 'provisional', reason: `awaiting acceptance of ${attempt.attemptId}` };
        return done();
      }
      attempt.status = 'accepted';
      const pred = predecessorState(record, attempt.cursorBefore);
      const state = pred.state;
      state.sceneReplyCount += 1;
      state.revision += 1;
      record.checkpoints[event.cursorAfter] = {
        cursor: event.cursorAfter,
        parentCursor: attempt.cursorBefore,
        stateAfter: clone(state),
        variantId: variant.variantId,
        acceptedResolutionId: null,
        observationOperationIds: [],
      };
      record.projection = { cursor: event.cursorAfter, state, status: pred.known ? 'current' : 'stale', reason: pred.known ? null : 'predecessor state was not known; set a baseline to continue tracking' };
      if (attempt.unadjudicated) notices.push(`attempt ${attempt.attemptId} was generated without the Director pipeline (unadjudicated)`);
      return done();
    }

    case 'observation_ready': {
      const attempt = record.attempts[event.attemptId];
      const variant = record.variants[event.variantId];
      if (!attempt || !variant || attempt.variantId !== event.variantId) return ignore('observation does not match the active attempt variant');
      if (attempt.status !== 'observing') return ignore(`observation for attempt ${event.attemptId} in status ${attempt.status} ignored`);
      if (event.observation.attemptId !== attempt.attemptId || event.observation.variantId !== variant.variantId || event.observation.baseCursor !== attempt.cursorBefore || event.observation.cursorAfter !== variant.cursorAfter) return ignore('observation identity mismatch');
      const pred = predecessorState(record, attempt.cursorBefore);
      if (event.observation.stateRevision !== pred.state.revision) return ignore('observation state revision is stale');
      variant.observation = clone(event.observation);
      variant.observerStatus = 'ready';
      variant.observerError = null;
      attempt.status = 'provisional';
      record.projection = { cursor: variant.cursorAfter, state: pred.state, status: 'provisional', reason: `variant ${variant.variantId} is observed and awaits implicit acceptance` };
      return done();
    }

    case 'observation_failed': {
      const attempt = record.attempts[event.attemptId];
      const variant = record.variants[event.variantId];
      if (!attempt || !variant || attempt.variantId !== event.variantId) return ignore('observation failure does not match the active attempt variant');
      if (attempt.status !== 'observing' && attempt.status !== 'provisional') return ignore(`observation failure for attempt ${event.attemptId} in status ${attempt.status} ignored`);
      attempt.status = 'stale';
      variant.observerStatus = 'failed';
      variant.observerError = event.error;
      const pred = predecessorState(record, attempt.cursorBefore);
      record.projection = { cursor: variant.cursorAfter, state: pred.state, status: 'stale', reason: `observer failed: ${event.error}` };
      return done();
    }

    case 'retry_observation': {
      const attempt = record.attempts[event.attemptId];
      const variant = record.variants[event.variantId];
      if (!attempt || !variant || attempt.variantId !== variant.variantId || variant.observerStatus !== 'failed') return ignore('no failed observation matches the retry request');
      attempt.status = 'observing';
      variant.acceptance = 'pending';
      variant.observerStatus = 'pending';
      variant.observerError = null;
      variant.observation = null;
      const pred = predecessorState(record, attempt.cursorBefore);
      record.projection = { cursor: variant.cursorAfter, state: pred.state, status: 'provisional', reason: `retrying observer for ${variant.variantId}` };
      return done();
    }

    case 'commit_observation': {
      if (record.appliedOperationIds.includes(event.operationId)) return ignore(`duplicate observation commit ${event.operationId} ignored`);
      const variant = record.variants[event.variantId];
      if (!variant || variant.acceptance !== 'pending' || variant.observerStatus !== 'ready' || !variant.observation || !variant.cursorAfter) return ignore(`variant ${event.variantId} has no ready observation to commit`);
      const attempt = record.attempts[variant.attemptId];
      if (!attempt || attempt.status !== 'provisional') return ignore(`attempt ${variant.attemptId} is not provisional`);
      const pred = predecessorState(record, variant.cursorBefore);
      if (!pred.known || pred.state.revision !== variant.observation.stateRevision) return ignore('observation commit predecessor is unknown or changed');
      record.appliedOperationIds.push(event.operationId);
      for (const operation of variant.observation.operations) {
        if (!record.appliedOperationIds.includes(operation.operationId)) record.appliedOperationIds.push(operation.operationId);
      }
      let state = applyObservationOperations(pred.state, variant.observation.operations);
      const realized = new Set(variant.observation.realizedResolutionIds);
      const resolution = attempt.resolutionId ? record.resolutions[attempt.resolutionId] : null;
      if (resolution && realized.has(resolution.resolutionId)) {
        if (resolution.status === 'prepared') resolution.status = 'accepted';
        const applied = applyEffects(state, effectsFor(resolution));
        state = applied.state;
        for (const refused of applied.refused) notices.push(`effect refused: ${refused}`);
        if (!state.acceptedResolutionIds.includes(resolution.resolutionId)) state.acceptedResolutionIds.push(resolution.resolutionId);
        const legacyTier = tierForResolution(resolution);
        const legacyFinal = resolution.outcomeFinal === undefined && resolution.outcomeInstruction === undefined && legacyTier === 'achieved';
        if (resolution.outcomeFinal === true || legacyFinal) {
          const scope = resolution.action.identityVersion === 2 ? (resolution.action.resolutionScope ?? 'attempt') : 'persistent';
          const def = defOfResolution(resolution) ?? (legacyFinal ? { name: resolution.outcome, instruction: instructionForResolution(resolution), records: 'achieved', final: true } : null);
          if (scope !== 'attempt' && def) {
            const variableId = gainVariableId(resolution.action);
            state.settledGains[variableId] = { variableId, resolutionId: resolution.resolutionId, outcome: def, scope, sceneId: scope === 'scene' ? (resolution.action.sceneId ?? state.sceneId) : null };
          }
        }
      }
      const permit = attempt.permitId ? record.permits[attempt.permitId] : null;
      if (permit) {
        const permitRealized = permit.actions.some(action => realized.has(action.resolutionId));
        if (permitRealized && !state.acceptedPermitIds.includes(permit.permitId)) state.acceptedPermitIds.push(permit.permitId);
        for (const action of permit.actions) {
          if (!realized.has(action.resolutionId)) continue;
          if (!state.acceptedResolutionIds.includes(action.resolutionId)) state.acceptedResolutionIds.push(action.resolutionId);
          if (action.recordedValue) state.variables[`permit:${action.resolutionId}`] = action.recordedValue;
        }
      }
      attempt.status = 'accepted';
      variant.acceptance = 'accepted';
      state.sceneReplyCount += 1;
      state.revision += 1;
      state.lastObservedCursor = variant.cursorAfter;
      state.trackingStatus = 'current';
      record.checkpoints[variant.cursorAfter] = {
        cursor: variant.cursorAfter,
        parentCursor: attempt.cursorBefore,
        stateAfter: clone(state),
        variantId: variant.variantId,
        acceptedResolutionId: resolution && realized.has(resolution.resolutionId) ? resolution.resolutionId : null,
        observationOperationIds: variant.observation.operations.map(operation => operation.operationId),
      };
      record.projection = { cursor: variant.cursorAfter, state, status: 'current', reason: null };
      return done();
    }

    case 'accept': {
      if (record.appliedOperationIds.includes(event.operationId)) return ignore(`duplicate acceptance ${event.operationId} ignored`);
      const attempt = record.attempts[event.attemptId];
      if (!attempt) return ignore(`acceptance for unknown attempt ${event.attemptId} ignored`);
      if (attempt.status !== 'provisional') return ignore(`acceptance for attempt ${event.attemptId} in status ${attempt.status} ignored`);
      const variant = attempt.variantId ? record.variants[attempt.variantId] : null;
      if (!variant || !variant.cursorAfter) return ignore(`acceptance for attempt ${event.attemptId} has no variant`);
      const resolution = attempt.resolutionId ? record.resolutions[attempt.resolutionId] : null;
      record.appliedOperationIds.push(event.operationId);
      attempt.status = 'accepted';
      variant.acceptance = 'accepted';
      const pred = predecessorState(record, attempt.cursorBefore);
      let state = pred.state;
      if (resolution) {
        if (resolution.status === 'prepared') resolution.status = 'accepted';
        const applied = applyEffects(state, effectsFor(resolution));
        state = applied.state;
        for (const r of applied.refused) notices.push(`effect refused: ${r}`);
        if (!state.acceptedResolutionIds.includes(resolution.resolutionId)) state.acceptedResolutionIds.push(resolution.resolutionId);
        const legacyTier = tierForResolution(resolution);
        const legacyFinal = resolution.outcomeFinal === undefined && resolution.outcomeInstruction === undefined && legacyTier === 'achieved';
        if (resolution.outcomeFinal === true || legacyFinal) {
          const scope = resolution.action.identityVersion === 2 ? (resolution.action.resolutionScope ?? 'attempt') : 'persistent';
          const def = defOfResolution(resolution) ?? (legacyFinal
            ? { name: resolution.outcome, instruction: instructionForResolution(resolution), records: 'achieved', final: true }
            : null);
          if (scope !== 'attempt' && def) {
            const variableId = gainVariableId(resolution.action);
            state.settledGains[variableId] = {
              variableId,
              resolutionId: resolution.resolutionId,
              outcome: def,
              scope,
              sceneId: scope === 'scene' ? (resolution.action.sceneId ?? state.sceneId) : null,
            };
          }
        }
      }
      state.sceneReplyCount += 1;
      state.revision += 1;
      record.checkpoints[variant.cursorAfter] = {
        cursor: variant.cursorAfter,
        parentCursor: attempt.cursorBefore,
        stateAfter: clone(state),
        variantId: variant.variantId,
        acceptedResolutionId: resolution?.resolutionId ?? null,
        observationOperationIds: [],
      };
      record.projection = { cursor: variant.cursorAfter, state, status: pred.known ? 'current' : 'stale', reason: pred.known ? null : 'predecessor state was not known; set a baseline to continue tracking' };
      return done();
    }

    case 'reject': {
      const attempt = record.attempts[event.attemptId];
      if (!attempt) return ignore(`rejection for unknown attempt ${event.attemptId} ignored`);
      if (attempt.status !== 'provisional' && attempt.status !== 'observing') return ignore(`rejection for attempt ${event.attemptId} in status ${attempt.status} ignored`);
      attempt.status = 'rejected';
      const variant = attempt.variantId ? record.variants[attempt.variantId] : null;
      if (variant) variant.acceptance = 'rejected';
      if (record.projection.status === 'provisional') {
        const pred = predecessorState(record, attempt.cursorBefore);
        record.projection = { cursor: attempt.cursorBefore, state: pred.state, status: pred.known ? 'current' : 'unknown', reason: pred.known ? null : 'predecessor unknown' };
      }
      return done();
    }

    case 'cancel': {
      let changed = false;
      const ids = event.attemptId ? [event.attemptId] : Object.keys(record.attempts);
      for (const id of ids) {
        const attempt = record.attempts[id];
        if (!attempt) continue;
        if (attempt.epoch !== event.epoch && event.attemptId === null) continue;
        if (attempt.status === 'prepared' || attempt.status === 'writing' || attempt.status === 'observing') {
          attempt.status = 'cancelled';
          changed = true;
        }
      }
      if (record.pending && (event.attemptId === null || record.pending.attemptId === event.attemptId)) {
        record.pending = null;
        changed = true;
      }
      if (record.projection.status === 'provisional' && event.attemptId) {
        // no change: cancellation of a different attempt does not touch a provisional head
      }
      if (!changed) return ignore(`cancel (${event.reason}): nothing to cancel`);
      notices.push(`cancelled: ${event.reason}`);
      return done();
    }

    case 'abort_epoch': {
      let changed = false;
      for (const attempt of Object.values(record.attempts)) {
        if (attempt.epoch === event.epoch && (attempt.status === 'prepared' || attempt.status === 'writing' || attempt.status === 'observing')) {
          attempt.status = 'cancelled';
          changed = true;
        }
      }
      if (record.pending) { record.pending = null; changed = true; }
      if (!changed) return ignore(`abort (${event.reason}): nothing in flight`);
      notices.push(`aborted in-flight work: ${event.reason}`);
      return done();
    }

    case 'select_variant': {
      let variant = event.variantId ? record.variants[event.variantId] ?? null : null;
      if (variant && variant.cursorAfter && variant.cursorAfter !== event.cursorAfter) {
        // The host copies `extra` into a new swipe slot; a marker whose text no longer matches is not this variant.
        notices.push(`variant ${variant.variantId} marker does not match the message text; treated as unknown`);
        variant = null;
      }
      const cursor = variant?.cursorAfter ?? event.cursorAfter;
      const cp = record.checkpoints[cursor];
      if (cp) {
        record.projection = { cursor, state: clone(cp.stateAfter), status: 'current', reason: null };
        return done();
      }
      if (variant && variant.acceptance === 'pending') {
        const pred = predecessorState(record, variant.cursorBefore);
        if (variant.observerStatus === 'failed') {
          record.projection = { cursor, state: pred.state, status: 'stale', reason: variant.observerError ?? `observer failed for ${variant.variantId}` };
          return done();
        }
        record.projection = { cursor, state: pred.state, status: 'provisional', reason: `variant ${variant.variantId} awaits acceptance` };
        return done();
      }
      if (variant && variant.acceptance === 'rejected') {
        const pred = predecessorState(record, variant.cursorBefore);
        if (variant.observerStatus === 'ready' && variant.observation) {
          variant.acceptance = 'pending';
          const attempt = record.attempts[variant.attemptId];
          if (attempt) attempt.status = 'provisional';
          record.projection = { cursor, state: pred.state, status: 'provisional', reason: `restored observed variant ${variant.variantId}; awaits implicit acceptance` };
          return done();
        }
        record.projection = { cursor, state: pred.state, status: 'stale', reason: `variant ${variant.variantId} was rejected; regenerate wording, reroll, or accept it` };
        return done();
      }
      record.projection = { cursor, state: record.projection.state, status: 'unknown', reason: 'no checkpoint for this variant' };
      return done();
    }

    case 'head_changed': {
      const chainSet = new Set(event.chain);
      // Prepared, unaccepted decisions bound to a prefix that no longer exists are invalidated (M1-05).
      for (const res of Object.values(record.resolutions)) {
        if (res.status === 'prepared' && res.cursorBefore && !chainSet.has(res.cursorBefore)) {
          res.status = 'invalidated';
          notices.push(`prepared resolution ${res.resolutionId} no longer matches the transcript and was invalidated`);
        }
      }
      for (const attempt of Object.values(record.attempts)) {
        if ((attempt.status === 'provisional' || attempt.status === 'observing') && attempt.cursorBefore && !chainSet.has(attempt.cursorBefore)) {
          attempt.status = 'stale';
          notices.push(`provisional attempt ${attempt.attemptId} no longer matches the transcript`);
        }
      }
      const cp = record.checkpoints[event.cursor];
      if (cp) {
        record.projection = { cursor: event.cursor, state: clone(cp.stateAfter), status: 'current', reason: null };
        return done();
      }
      const provisional = Object.values(record.variants).find(v => v.cursorAfter === event.cursor && v.acceptance === 'pending');
      if (provisional) {
        const pred = predecessorState(record, provisional.cursorBefore);
        if (provisional.observerStatus === 'failed') {
          record.projection = { cursor: event.cursor, state: pred.state, status: 'stale', reason: provisional.observerError ?? `observer failed for ${provisional.variantId}` };
          return done();
        }
        record.projection = { cursor: event.cursor, state: pred.state, status: 'provisional', reason: `variant ${provisional.variantId} awaits acceptance` };
        return done();
      }
      if (event.reason === 'edit') {
        record.projection = { cursor: event.cursor, state: record.projection.state, status: 'stale', reason: 'an earlier message was edited; rebuild from a checkpoint or set a baseline' };
        return done();
      }
      record.projection = { cursor: event.cursor, state: record.projection.state, status: 'unknown', reason: `no checkpoint matches the current transcript (${event.reason})` };
      return done();
    }

    case 'reroll': {
      const previous = record.resolutions[event.previousResolutionId];
      if (!previous) return ignore(`reroll of unknown resolution ${event.previousResolutionId} ignored`);
      if (previous.status === 'prepared') previous.status = 'superseded';
      const next = clone(event.resolution);
      next.previousResolutionId = previous.resolutionId;
      next.cursorBefore = previous.cursorBefore;
      next.generation = previous.generation + 1;
      next.status = 'prepared';
      record.resolutions[next.resolutionId] = next;
      return done();
    }

    case 'invalidate_prepared': {
      let changed = false;
      for (const res of Object.values(record.resolutions)) {
        if (res.status !== 'prepared') continue;
        if (event.onlyUnbound && res.cursorBefore !== null) continue;
        if (event.profileRevision && res.policyRevision === event.profileRevision) continue;
        res.status = 'invalidated';
        changed = true;
      }
      if (record.pending) {
        const attempt = record.attempts[record.pending.attemptId];
        if (attempt && attempt.status === 'prepared') attempt.status = 'cancelled';
        record.pending = null;
        changed = true;
      }
      if (event.profileRevision) record.profileRevision = event.profileRevision;
      if (!changed) return ignore(`nothing to invalidate (${event.reason})`);
      notices.push(`invalidated unused preparation: ${event.reason}`);
      return done();
    }

    case 'set_baseline': {
      const state = clone(event.state);
      record.checkpoints[event.cursor] = { cursor: event.cursor, parentCursor: null, stateAfter: clone(state), variantId: null, acceptedResolutionId: null, observationOperationIds: [] };
      record.projection = { cursor: event.cursor, state, status: 'current', reason: null };
      notices.push(`baseline set (${event.reason}); earlier state was not reconstructed`);
      return done();
    }

    case 'start_scene': {
      if (record.projection.status !== 'current') return ignore(`cannot start scene while projection is ${record.projection.status}`);
      const state = clone(record.projection.state);
      state.sceneId += 1;
      state.sceneReplyCount = 0;
      state.revision += 1;
      record.checkpoints[event.cursor] = {
        cursor: event.cursor,
        parentCursor: record.checkpoints[event.cursor]?.parentCursor ?? null,
        stateAfter: clone(state),
        variantId: record.checkpoints[event.cursor]?.variantId ?? null,
        acceptedResolutionId: record.checkpoints[event.cursor]?.acceptedResolutionId ?? null,
        observationOperationIds: [...(record.checkpoints[event.cursor]?.observationOperationIds ?? [])],
      };
      record.projection = { cursor: event.cursor, state, status: 'current', reason: null };
      notices.push(`scene advanced to ${state.sceneId} (${event.reason})`);
      return done();
    }

    case 'extend_checkpoint': {
      if (record.checkpoints[event.cursor]) return ignore('checkpoint already exists');
      const parent = record.checkpoints[event.parentCursor];
      if (!parent) return ignore(`cannot extend: no checkpoint at ${event.parentCursor}`);
      record.checkpoints[event.cursor] = { cursor: event.cursor, parentCursor: event.parentCursor, stateAfter: clone(parent.stateAfter), variantId: null, acceptedResolutionId: null, observationOperationIds: [] };
      if (record.projection.cursor === event.parentCursor || record.projection.status === 'unknown') {
        record.projection = { cursor: event.cursor, state: clone(parent.stateAfter), status: 'current', reason: null };
      }
      return done();
    }

    case 'inspect': {
      record.inspector.push(clone(event.entry));
      if (record.inspector.length > INSPECTOR_LIMIT) record.inspector.splice(0, record.inspector.length - INSPECTOR_LIMIT);
      return done();
    }

    default:
      return ignore('unknown event');
  }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** The resolution that constrains new generations at a prefix: highest generation among prepared/accepted. */
export function activeResolutionForCursor(record: DirectorChatRecord, cursor: string): FrozenResolution | null {
  let best: FrozenResolution | null = null;
  for (const res of Object.values(record.resolutions)) {
    if (res.cursorBefore !== cursor) continue;
    if (res.status !== 'prepared' && res.status !== 'accepted') continue;
    if (!best || res.generation > best.generation || (res.generation === best.generation && res.createdAt > best.createdAt)) best = res;
  }
  return best;
}

export function provisionalAttempts(record: DirectorChatRecord): GenerationAttempt[] {
  return Object.values(record.attempts).filter(a => a.status === 'provisional' || a.status === 'observing');
}

export function attemptForVariant(record: DirectorChatRecord, variantId: string): GenerationAttempt | null {
  const v = record.variants[variantId];
  return v ? record.attempts[v.attemptId] ?? null : null;
}

export function resolutionsForAction(record: DirectorChatRecord, actionId: string): FrozenResolution[] {
  return Object.values(record.resolutions).filter(r => r.actionId === actionId).sort((a, b) => a.generation - b.generation);
}
