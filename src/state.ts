/**
 * Frozen-turn history. Completing a writer attempt records its variant directly;
 * story.ts owns branch-aware meters, secrets and lore. No post-reply state gate
 * can hold up the next message.
 */
import { emptyStory, normalizeStory } from './story.ts';
import { decodeRecordStorage } from './state-storage.ts';
import type { ReactionResult } from './npc-reaction.ts';
import type {
  ActionSpec, ActorBinding, DirectorChatRecord, FrozenResolution,
  GenerationAttempt, GenerationType, InspectorEntry, SpeakerDecision, StorySnapshot, TurnPermit,
} from './types.ts';

export const INSPECTOR_LIMIT = 200;
/** Older Activity rows keep their summary without repeated judge payloads. */
export const INSPECTOR_DETAIL_LIMIT = 8;
/** Exact judge replay and off-chain dice survive for twenty distinct user turns. */
export const REPLAY_TURN_LIMIT = 20;
export const RECORD_BACKUP_KEY = 'rpDirector_0_7_backup';

export function needsLegacyRecordBackup(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const record = raw as Partial<DirectorChatRecord>;
  return record.schemaVersion === 1 && record.dataVersion !== 2;
}

export function trimInspector(entries: InspectorEntry[]): InspectorEntry[] {
  const kept = entries.slice(-INSPECTOR_LIMIT);
  const cut = kept.length - INSPECTOR_DETAIL_LIMIT;
  return kept.map((entry, index) => index < cut && (entry.stateSent != null || entry.questions != null || entry.injectedText != null || entry.answers != null)
    ? { ...entry, stateSent: null, questions: null, injectedText: null, answers: null }
    : entry);
}

export function newRecord(seedId: string, profileRevision: string): DirectorChatRecord {
  return {
    schemaVersion: 1, dataVersion: 2, seedId, actors: {}, actions: {}, resolutions: {}, permits: {},
    attempts: {}, variants: {}, appliedOperationIds: [], pending: null, paused: false, replyCheckRerolls: [],
    inspector: [], profileRevision, story: emptyStory(),
  };
}

/** Loads 0.7 records without reviving observer, checkpoint, or repair state. */
export function normalizeRecord(raw: unknown, seedId: string, profileRevision: string): DirectorChatRecord {
  raw = decodeRecordStorage(raw);
  const base = newRecord(seedId, profileRevision);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const r = raw as Partial<DirectorChatRecord>;
  if (r.schemaVersion !== 1) return base;
  const map = <T>(value: unknown): Record<string, T> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item && typeof item === 'object' && !Array.isArray(item)).map(([key, item]) => [key, structuredClone(item)]));
  };
  const normalized: DirectorChatRecord = {
    ...base,
    seedId: typeof r.seedId === 'string' && r.seedId ? r.seedId : seedId,
    actors: map(r.actors), actions: map(r.actions), resolutions: map(r.resolutions),
    permits: map(r.permits), attempts: map(r.attempts), variants: map(r.variants),
    appliedOperationIds: Array.isArray(r.appliedOperationIds) ? r.appliedOperationIds.filter(x => typeof x === 'string') : [],
    paused: r.paused === true,
    replyCheckRerolls: Array.isArray(r.replyCheckRerolls) ? [...new Set(r.replyCheckRerolls.filter(key => typeof key === 'string'))] : [],
    inspector: Array.isArray(r.inspector) ? trimInspector(structuredClone(r.inspector)) : [],
    profileRevision: typeof r.profileRevision === 'string' ? r.profileRevision : profileRevision,
    story: normalizeStory(r.story),
    ...(Array.isArray(r.transcriptCursors) && r.transcriptCursors.every(cursor => typeof cursor === 'string') ? { transcriptCursors: [...r.transcriptCursors] } : {}),
    ...(r.dataVersion !== 2 || r.legacyStoryLayout ? { legacyStoryLayout: true as const } : {}),
  };
  for (const variant of Object.values(normalized.variants)) {
    const saved = variant as unknown as Record<string, unknown>;
    delete saved.observerStatus;
    delete saved.observation;
    delete saved.observerError;
    // Completed 0.7 replies remain reusable even when their observer never ran.
    const attempt = normalized.attempts[variant.attemptId];
    if (attempt && attempt.variantId === variant.variantId && saved.acceptance !== 'rejected') {
      attempt.status = 'accepted';
    }
    delete saved.acceptance;
  }
  // Promises and host generations cannot resume after a browser reload.
  for (const attempt of Object.values(normalized.attempts)) {
    // An imported shared-text reference may be damaged. Omit its optional
    // block so frozen story state can rebuild it; never pass an object to prose.
    if (typeof attempt.injectedText !== 'string') attempt.injectedText = '';
    if (attempt.frozenStateBlock !== undefined && typeof attempt.frozenStateBlock !== 'string') delete attempt.frozenStateBlock;
    if (attempt.inputText !== undefined && typeof attempt.inputText !== 'string') delete attempt.inputText;
    if (['prepared', 'writing', 'observing', 'provisional'].includes(attempt.status)) attempt.status = 'cancelled';
  }
  // Removed observer Activity rows are historical information, not active kinds.
  for (const entry of normalized.inspector) if (['observer', 'acceptance', 'restore', 'native_bypass'].includes(entry.kind)) entry.kind = 'info';
  return normalized;
}

type FrozenTurn = {
  reaction?: ReactionResult | null;
  frozenSpeaker?: SpeakerDecision | null;
  frozenStateBlock?: string;
  storyBefore?: StorySnapshot | null;
  storyAfter?: StorySnapshot | null;
  frozenLorePlan?: { force: string[]; managed: string[]; nearEnd?: boolean } | null;
  judgeErrors?: string[];
  judgeFailedStages?: string[];
  stageRecords?: GenerationAttempt['stageRecords'];
  turnKind?: GenerationAttempt['turnKind'];
  inputText?: string;
  loreCursor?: string | null;
};

export type DirectorEvent =
  | { type: 'bind_actor'; binding: ActorBinding }
  | ({ type: 'prepare'; resolution: FrozenResolution | null; action: ActionSpec | null; attemptId: string; actorId: string | null; epoch: number; composerText: string; now: number } & FrozenTurn)
  | { type: 'bind'; attemptId: string; cursorBefore: string; epoch: number; injectedText: string; toolOffered?: boolean }
  | { type: 'tool_result'; attemptId: string; permit: TurnPermit | null; status: 'permitted' | 'failed' | 'malformed'; error: string | null }
  | { type: 'store_permit'; permit: TurnPermit }
  | { type: 'store_resolution'; resolution: FrozenResolution }
  | ({ type: 'regeneration_attempt'; attemptId: string; resolutionId: string | null; permitId?: string | null; cursorBefore: string; epoch: number; generationType: GenerationType; actorId: string | null; injectedText: string; unadjudicated: boolean; now: number } & FrozenTurn)
  | { type: 'completed'; attemptId: string; epoch: number; operationId: string; variantId: string; hostMessageRef: number | null; hostVariantRef: number | null; cursorAfter: string; now: number; actorId?: string | null }
  | { type: 'cancel'; attemptId: string | null; epoch: number; reason: string }
  | { type: 'abort_epoch'; epoch: number; reason: string }
  | { type: 'select_variant'; variantId: string | null; cursorAfter: string; chain: string[] }
  | { type: 'head_changed'; cursor: string; chain: string[]; reason: 'edit' | 'delete' | 'load' | 'branch' | 'continue' | 'unknown' }
  | { type: 'reroll'; previousResolutionId: string; resolution: FrozenResolution; now: number }
  | { type: 'invalidate_prepared'; reason: string; onlyUnbound: boolean; profileRevision: string | null }
  | { type: 'inspect'; entry: InspectorEntry };

export interface ApplyResult {
  record: DirectorChatRecord;
  notices: string[];
  changed: boolean;
}

const clone = <T>(value: T): T => structuredClone(value);
const frozenTurn = (event: FrozenTurn): FrozenTurn => ({
  reaction: clone(event.reaction ?? null), frozenSpeaker: clone(event.frozenSpeaker ?? null),
  frozenStateBlock: event.frozenStateBlock ?? '', frozenLorePlan: clone(event.frozenLorePlan ?? null), judgeErrors: [...(event.judgeErrors ?? [])],
  loreCursor: event.loreCursor ?? null,
  ...(event.judgeFailedStages === undefined ? {} : { judgeFailedStages: [...event.judgeFailedStages] }),
  ...(event.stageRecords === undefined ? {} : { stageRecords: clone(event.stageRecords) }),
  ...(event.turnKind === undefined ? {} : { turnKind: event.turnKind }),
  ...(event.inputText === undefined ? {} : { inputText: event.inputText }),
  ...(event.storyBefore === undefined ? {} : { storyBefore: clone(event.storyBefore) }),
  ...(event.storyAfter === undefined ? {} : { storyAfter: clone(event.storyAfter) }),
});

export function applyEvent(input: DirectorChatRecord, event: DirectorEvent): ApplyResult {
  const record = clone(input);
  const notices: string[] = [];
  const done = (): ApplyResult => ({ record, notices, changed: true });
  const ignore = (why: string): ApplyResult => ({ record: input, notices: [why], changed: false });
  switch (event.type) {
    case 'bind_actor':
      record.actors[event.binding.actorId] = clone(event.binding);
      return done();
    case 'prepare': {
      if (record.attempts[event.attemptId]) return ignore('attempt already exists');
      if (record.pending) {
        const previous = record.attempts[record.pending.attemptId];
        if (previous?.status === 'prepared') previous.status = 'cancelled';
      }
      if (event.action) record.actions[event.action.actionId] = clone(event.action);
      if (event.resolution) record.resolutions[event.resolution.resolutionId] = clone(event.resolution);
      record.attempts[event.attemptId] = {
        attemptId: event.attemptId, resolutionId: event.resolution?.resolutionId ?? null,
        permitId: null, ...frozenTurn(event), actorId: event.actorId, cursorBefore: null,
        status: 'prepared', generationType: 'normal', hostMessageRef: null, hostVariantRef: null,
        variantId: null, injectedText: '', epoch: event.epoch, unadjudicated: false,
        toolStatus: 'not_offered', toolError: null, createdAt: event.now,
      };
      record.pending = {
        attemptId: event.attemptId, resolutionId: event.resolution?.resolutionId ?? null,
        actorId: event.actorId, epoch: event.epoch, composerText: event.composerText, createdAt: event.now,
      };
      return done();
    }
    case 'bind': {
      const pending = record.pending;
      const attempt = record.attempts[event.attemptId];
      if (!pending || pending.attemptId !== event.attemptId || pending.epoch !== event.epoch || !attempt) return ignore('bind does not match pending attempt');
      attempt.cursorBefore = event.cursorBefore;
      attempt.status = 'writing';
      attempt.injectedText = event.injectedText;
      attempt.toolStatus = event.toolOffered ? 'offered' : 'not_offered';
      const resolution = attempt.resolutionId ? record.resolutions[attempt.resolutionId] : null;
      if (resolution) {
        if (resolution.cursorBefore === null) resolution.cursorBefore = event.cursorBefore;
        else if (resolution.cursorBefore !== event.cursorBefore) {
          attempt.resolutionId = null;
          attempt.unadjudicated = true;
          attempt.injectedText = '';
          notices.push('stored ruling did not match this message; proceeding unruled');
        }
      }
      record.pending = null;
      return done();
    }
    case 'store_permit':
      record.permits[event.permit.permitId] = clone(event.permit);
      return done();
    case 'store_resolution':
      record.actions[event.resolution.actionId] = clone(event.resolution.action);
      record.resolutions[event.resolution.resolutionId] = clone(event.resolution);
      return done();
    case 'tool_result': {
      const attempt = record.attempts[event.attemptId];
      if (!attempt || attempt.status !== 'writing') return ignore('tool result is not for the active attempt');
      if (event.permit && (event.permit.attemptId !== attempt.attemptId || event.permit.baseCursor !== attempt.cursorBefore)) return ignore('tool result identity does not match');
      attempt.toolStatus = event.status;
      attempt.toolError = event.error;
      if (event.permit) {
        record.permits[event.permit.permitId] = clone(event.permit);
        attempt.permitId = event.permit.permitId;
        attempt.reaction = null;
      }
      return done();
    }
    case 'regeneration_attempt':
      if (record.attempts[event.attemptId]) return ignore('attempt already exists');
      record.attempts[event.attemptId] = {
        attemptId: event.attemptId, resolutionId: event.resolutionId, permitId: event.permitId ?? null,
        ...frozenTurn(event), actorId: event.actorId, cursorBefore: event.cursorBefore, status: 'writing',
        generationType: event.generationType, hostMessageRef: null, hostVariantRef: null, variantId: null,
        injectedText: event.injectedText, epoch: event.epoch, unadjudicated: event.unadjudicated,
        toolStatus: event.permitId ? 'reused' : 'not_offered', toolError: null, createdAt: event.now,
      };
      return done();
    case 'completed': {
      if (record.appliedOperationIds.includes(event.operationId)) return ignore('duplicate completion');
      const attempt = record.attempts[event.attemptId];
      if (!attempt || attempt.epoch !== event.epoch || attempt.status !== 'writing') return ignore('completion does not match an active attempt');
      record.appliedOperationIds.push(event.operationId);
      attempt.hostMessageRef = event.hostMessageRef;
      attempt.hostVariantRef = event.hostVariantRef;
      attempt.variantId = event.variantId;
      if (attempt.actorId === null && event.actorId) attempt.actorId = event.actorId;
      attempt.status = 'accepted';
      const resolution = attempt.resolutionId ? record.resolutions[attempt.resolutionId] : null;
      if (resolution?.status === 'prepared') resolution.status = 'accepted';
      record.variants[event.variantId] = {
        variantId: event.variantId, attemptId: attempt.attemptId, resolutionId: attempt.resolutionId,
        permitId: attempt.permitId ?? null, actorId: attempt.actorId, cursorBefore: attempt.cursorBefore,
        cursorAfter: event.cursorAfter,
      };
      return done();
    }
    case 'cancel':
    case 'abort_epoch': {
      let changed = false;
      const attemptId = event.type === 'cancel' ? event.attemptId : null;
      for (const attempt of Object.values(record.attempts)) {
        if (attemptId !== null ? attempt.attemptId !== attemptId : attempt.epoch !== event.epoch) continue;
        if (attempt.status === 'prepared' || attempt.status === 'writing') {
          attempt.status = 'cancelled';
          changed = true;
        }
      }
      if (record.pending && record.pending.epoch === event.epoch && (attemptId === null || record.pending.attemptId === attemptId)) {
        record.pending = null;
        changed = true;
      }
      return changed ? done() : ignore('nothing in flight');
    }
    case 'select_variant':
    case 'head_changed':
      // Story snapshots select themselves by transcript cursor. Frozen history
      // remains intact so returning to an earlier swipe restores its decision.
      return ignore('transcript selection does not change frozen history');
    case 'reroll': {
      const previous = record.resolutions[event.previousResolutionId];
      if (!previous) return ignore('unknown prior ruling');
      const next = clone(event.resolution);
      next.previousResolutionId = previous.resolutionId;
      next.cursorBefore = previous.cursorBefore;
      next.generation = previous.generation + 1;
      next.status = 'prepared';
      if (previous.status === 'prepared') previous.status = 'superseded';
      record.resolutions[next.resolutionId] = next;
      return done();
    }
    case 'invalidate_prepared': {
      let changed = false;
      for (const resolution of Object.values(record.resolutions)) {
        // A settings edit must never reinterpret an already bound turn.
        if (resolution.status !== 'prepared' || resolution.cursorBefore !== null) continue;
        if (event.profileRevision && resolution.policyRevision === event.profileRevision) continue;
        resolution.status = 'invalidated';
        changed = true;
      }
      if (record.pending) {
        const attempt = record.attempts[record.pending.attemptId];
        if (attempt?.status === 'prepared') attempt.status = 'cancelled';
        record.pending = null;
        changed = true;
      }
      if (event.profileRevision && record.profileRevision !== event.profileRevision) {
        record.profileRevision = event.profileRevision;
        changed = true;
      }
      return changed ? done() : ignore('no unused preparation');
    }
    case 'inspect':
      record.inspector.push(clone(event.entry));
      record.inspector = trimInspector(record.inspector);
      return done();
    default:
      return ignore('unknown event');
  }
}

/** New explicit draws take priority; saved variants keep their original links. */
export function activeResolutionForCursor(record: DirectorChatRecord, cursor: string): FrozenResolution | null {
  let best: FrozenResolution | null = null;
  for (const resolution of Object.values(record.resolutions)) {
    if (resolution.cursorBefore !== cursor || (resolution.status !== 'prepared' && resolution.status !== 'accepted')) continue;
    if (!best || resolution.generation > best.generation || (resolution.generation === best.generation && resolution.createdAt > best.createdAt)) best = resolution;
  }
  return best;
}

export function attemptForVariant(record: DirectorChatRecord, variantId: string): GenerationAttempt | null {
  const variant = record.variants[variantId];
  return variant ? record.attempts[variant.attemptId] ?? null : null;
}

export function resolutionsForAction(record: DirectorChatRecord, actionId: string): FrozenResolution[] {
  return Object.values(record.resolutions).filter(r => r.actionId === actionId).sort((a, b) => a.generation - b.generation);
}

export interface LiveRecordReferences {
  /** Every cursor on the currently selected transcript chain, including its root. */
  liveCursors: readonly string[];
  /** Markers on every surviving message and swipe, including unselected swipes. */
  liveVariantIds: readonly string[];
  activeAttemptIds?: readonly (string | null | undefined)[];
  activeResolutionIds?: readonly (string | null | undefined)[];
  activePermitIds?: readonly (string | null | undefined)[];
}

/**
 * Drop unreachable frozen payloads, retaining every live swipe and the newest
 * attempt for each live input cursor. The latter is essential: deleting a reply
 * to regenerate it, or a failed writer with no reply marker, must not buy a new
 * ruling. Activity supplies the bounded historical summary after payload removal.
 */
export function compactRecord(input: DirectorChatRecord, live: LiveRecordReferences): DirectorChatRecord {
  const record = clone(input);
  const cursors = new Set(live.liveCursors);
  const attemptIds = new Set(live.activeAttemptIds?.filter((id): id is string => typeof id === 'string'));
  const resolutionIds = new Set(live.activeResolutionIds?.filter((id): id is string => typeof id === 'string'));
  const permitIds = new Set(live.activePermitIds?.filter((id): id is string => typeof id === 'string'));
  const variantIds = new Set(live.liveVariantIds);
  const newestByCursor = new Map<string, GenerationAttempt>();
  const firstByCursor = new Map<string, GenerationAttempt>();
  for (const attempt of Object.values(record.attempts)) {
    if (!attempt.cursorBefore) continue;
    const first = firstByCursor.get(attempt.cursorBefore);
    if (!first || attempt.createdAt < first.createdAt) firstByCursor.set(attempt.cursorBefore, attempt);
  }
  // Wording swipes and explicit rerolls cannot make an old user turn young.
  // Next beats between user turns share that age window without consuming it.
  const turns = [...firstByCursor.values()].sort((a, b) => b.createdAt - a.createdAt);
  const userTurns = turns.filter(attempt => attempt.turnKind !== 'director_next');
  const cutoff = (userTurns.length ? userTurns : turns)[REPLAY_TURN_LIMIT - 1]?.createdAt ?? -Infinity;
  const recentCursors = new Set(turns.filter(attempt => attempt.createdAt >= cutoff).map(attempt => attempt.cursorBefore!));
  const replayResolutionIds = new Set(resolutionIds);
  const replayPermitIds = new Set(permitIds);
  for (const attempt of Object.values(record.attempts)) {
    if (attempt.status === 'writing' || record.pending?.attemptId === attempt.attemptId) attemptIds.add(attempt.attemptId);
    if (attempt.cursorBefore && recentCursors.has(attempt.cursorBefore)) {
      if (attempt.resolutionId || attempt.permitId) attemptIds.add(attempt.attemptId);
      if (attempt.resolutionId) replayResolutionIds.add(attempt.resolutionId);
      if (attempt.permitId) replayPermitIds.add(attempt.permitId);
    }
    if (attemptIds.has(attempt.attemptId)) {
      if (attempt.resolutionId) replayResolutionIds.add(attempt.resolutionId);
      if (attempt.permitId) replayPermitIds.add(attempt.permitId);
    }
    if (!attempt.cursorBefore || !cursors.has(attempt.cursorBefore)) continue;
    const prior = newestByCursor.get(attempt.cursorBefore);
    if (!prior || attempt.createdAt >= prior.createdAt) newestByCursor.set(attempt.cursorBefore, attempt);
  }
  for (const attempt of newestByCursor.values()) attemptIds.add(attempt.attemptId);
  for (const [id, variant] of Object.entries(record.variants)) {
    if (!variantIds.has(id)) { delete record.variants[id]; continue; }
    attemptIds.add(variant.attemptId);
    if (variant.resolutionId) resolutionIds.add(variant.resolutionId);
    if (variant.permitId) permitIds.add(variant.permitId);
    if (variant.cursorBefore) cursors.add(variant.cursorBefore);
    if (variant.cursorAfter) cursors.add(variant.cursorAfter);
  }
  for (const [id, attempt] of Object.entries(record.attempts)) {
    if (!attemptIds.has(id)) { delete record.attempts[id]; continue; }
    if (attempt.resolutionId) resolutionIds.add(attempt.resolutionId);
    if (attempt.permitId) permitIds.add(attempt.permitId);
    if (attempt.cursorBefore) cursors.add(attempt.cursorBefore);
    if (attempt.loreCursor) cursors.add(attempt.loreCursor);
    if (attempt.cursorBefore && !recentCursors.has(attempt.cursorBefore) && !live.activeAttemptIds?.includes(id)) {
      attempt.replayTrimmed = true;
      delete attempt.stageRecords;
    }
    if (!attempt.judgeFailedStages?.some(stage => ['move', 'route', 'ruling'].includes(stage))) delete attempt.stageRecords;
    else if (attempt.stageRecords) {
      // Retry compares the saved questions and answers, never the original
      // request payload. Keep full ruling evidence in resolution.snapshot only.
      attempt.stageRecords = attempt.stageRecords.map(stage => ({ ...stage, state: null }));
    }
    // A removed reply's attempt remains the reusable turn, not a phantom swipe.
    if (attempt.variantId && !record.variants[attempt.variantId]) {
      attempt.variantId = null;
      attempt.hostMessageRef = null;
      attempt.hostVariantRef = null;
    }
  }
  const actionIds = new Set<string>();
  for (const [id, resolution] of Object.entries(record.resolutions)) {
    if (!resolutionIds.has(id)) { delete record.resolutions[id]; continue; }
    if (!replayResolutionIds.has(id)) {
      resolution.snapshot.state = null;
      resolution.replayTrimmed = true;
    }
    actionIds.add(resolution.actionId);
  }
  for (const [id, permit] of Object.entries(record.permits)) {
    if (!permitIds.has(id)) { delete record.permits[id]; continue; }
    if (!replayPermitIds.has(id)) {
      delete permit.proposal;
      delete permit.snapshot;
      delete permit.profile;
      delete permit.reviewHistory;
      permit.replayTrimmed = true;
    }
    // Review history can contain full repeated question/evidence payloads. Its
    // latest eight choices are sufficient audit detail; the kept permit is full.
    if (permit.reviewHistory) permit.reviewHistory = permit.reviewHistory.slice(-INSPECTOR_DETAIL_LIMIT);
  }
  for (const id of Object.keys(record.actions)) if (!actionIds.has(id)) delete record.actions[id];
  record.inspector = trimInspector(record.inspector);
  // Completed attempts cannot complete again, even after their operation ID is
  // evicted, because completion accepts only the writing status.
  record.appliedOperationIds = record.appliedOperationIds.slice(-INSPECTOR_LIMIT);
  // Retain the allowance for every reachable turn (including old selected
  // history) and the same recent off-chain window as frozen rulings.
  record.replyCheckRerolls = record.replyCheckRerolls?.filter(cursor => cursors.has(cursor) || recentCursors.has(cursor));

  const aliases: Record<string, string> = {};
  const historyKeys = new Set(cursors);
  for (const [cursor, target] of Object.entries(record.story.historyAliases ?? {})) {
    if (!cursors.has(cursor) || !record.story.history[target]) continue;
    aliases[cursor] = target;
    historyKeys.add(target);
  }
  for (const cursor of Object.keys(record.story.history)) if (!historyKeys.has(cursor)) delete record.story.history[cursor];
  // Older builds stored a complete snapshot for every wording. Compact those
  // existing duplicates too, without losing the cursors that name them.
  const byValue = new Map<string, string>();
  for (const [cursor, snapshot] of Object.entries(record.story.history)) {
    const key = JSON.stringify(snapshot);
    const shared = byValue.get(key);
    if (!shared) { byValue.set(key, cursor); continue; }
    delete record.story.history[cursor];
    if (cursors.has(cursor)) aliases[cursor] = shared;
    for (const alias of Object.keys(aliases)) if (aliases[alias] === cursor) aliases[alias] = shared;
  }
  if (record.story.historyAliases || Object.keys(aliases).length) record.story.historyAliases = aliases;
  for (const cursor of Object.keys(record.story.lore)) if (!cursors.has(cursor)) delete record.story.lore[cursor];
  return record;
}

/** Never silently re-judge an old turn after its original evidence was trimmed. */
export function replayIsTrimmed(record: DirectorChatRecord, attempt: GenerationAttempt): boolean {
  return attempt.replayTrimmed === true
    || Boolean(attempt.resolutionId && record.resolutions[attempt.resolutionId]?.replayTrimmed)
    || Boolean(attempt.permitId && record.permits[attempt.permitId]?.replayTrimmed);
}
