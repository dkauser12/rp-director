import type { DirectorChatRecord, FrozenResolution, GenerationAttempt, TurnPermit } from './types.ts';
import type { GenrePack } from './pack/pack.ts';
import { meterLabel } from './pack/pack.ts';
import { PLAYER_LABEL, uiActorName } from './identity.ts';
import { YIELD } from './types.ts';
import type { RequestUsage } from './types.ts';
import { isRequestUsage, mergeRequestUsage } from './usage.ts';

export const WORKFLOW_BADGE_KEY = 'rpdWorkflow';

export interface WorkflowResult {
  source: 'move' | 'npc';
  actorId: string;
  action: string;
  outcome: string;
  instruction: string;
  /** Frozen probability of this outcome in dice mode, not judge confidence. */
  odds: number | null;
  draw: number | null;
}

export interface WorkflowRoute {
  actorId: string;
  targetActorIds: string[];
  kind: string;
}

export interface WorkflowMeterChange {
  actorId: string;
  meter: string;
  label: string;
  from: number | null;
  to: number;
  fromLabel: string;
  toLabel: string;
}

/** Immutable reply details; optional fields keep phase 1 badges readable. */
export interface WorkflowBadge {
  schemaVersion: 1;
  requestUsage?: RequestUsage[];
  pacing?: GenerationAttempt['frozenPacing'];
  replyCheck?: GenerationAttempt['replyCheck'];
  replyCheckError?: string;
  rerolledByCheck?: GenerationAttempt['rerolledByCheck'];
  replyOriginalSwipe?: number;
  attemptId: string;
  unavailable: boolean;
  /** Retry changes only the failed decision stages, never a successful draw. */
  retryEligible?: boolean;
  toolError?: string | null;
  errors: string[];
  results: WorkflowResult[];
  reaction: { actorId: string; outcome: string; draw: number } | null;
  createdAt?: number;
  actorNames?: Record<string, string>;
  move?: string | null;
  route?: WorkflowRoute | null;
  /** Exact text sent to the writer, for inspection only; never re-injected from UI data. */
  writerInstruction?: string;
  speaker?: { actorId: string; name: string } | null;
  meterChanges?: WorkflowMeterChange[];
  reveals?: { secretId: string; text: string; actorIds: string[] }[];
  lore?: { world: string; uid: number; title: string }[];
}

export function buildWorkflowBadge(input: {
  attempt: GenerationAttempt;
  resolution?: FrozenResolution | null;
  permit?: TurnPermit | null;
  record?: DirectorChatRecord | null;
  pack?: GenrePack;
}): WorkflowBadge {
  const { attempt, resolution, permit, record, pack } = input;
  const results: WorkflowResult[] = [];
  if (resolution) results.push({
    source: 'move',
    actorId: resolution.action.actingActorId ?? resolution.action.playerActorId,
    action: resolution.action.attemptedAction,
    outcome: resolution.outcome,
    instruction: resolution.outcomeInstruction ?? '',
    odds: resolution.method === 'sample' ? resolution.policyBand?.sampleWeights[resolution.outcome] ?? null : null,
    draw: resolution.draw,
  });
  for (const action of permit?.actions ?? []) results.push({
    source: 'npc',
    actorId: action.actingActorId,
    action: action.method,
    outcome: action.outcome,
    instruction: action.instruction,
    odds: action.methodUsed === 'sample' ? action.policyBand?.sampleWeights[action.outcome] ?? null : null,
    draw: action.draw ?? null,
  });
  const errors = [...new Set(attempt.judgeErrors ?? [])];
  if (attempt.toolError && !errors.includes(attempt.toolError)) errors.push(attempt.toolError);
  const actorNames = Object.fromEntries(Object.values(record?.actors ?? {}).map(actor => [actor.actorId, uiActorName(actor.actorId, actor.name)]));
  actorNames.player = PLAYER_LABEL;
  actorNames[YIELD] = PLAYER_LABEL;
  const speakerId = attempt.frozenSpeaker?.selected ?? null;
  const moveStage = attempt.stageRecords?.find(stage => stage.stage === 'move');
  const selectedMove = moveStage?.result.answers.move;
  const moveQuestion = moveStage?.questions.move;
  const selectedSentence = selectedMove?.type === 'choice' && !['NONE', 'ROUTINE'].includes(selectedMove.choice)
    && moveQuestion?.type === 'choice' ? moveQuestion.criteria[selectedMove.choice] ?? null : null;
  const routeStage = attempt.stageRecords?.find(stage => stage.stage === 'route');
  const routeChoice = (key: string) => {
    const answer = routeStage?.result.answers[key];
    return answer?.type === 'choice' && answer.choice !== 'UNRESOLVED' ? answer.choice : null;
  };
  const actorId = resolution?.action.actingActorId ?? resolution?.action.playerActorId ?? routeChoice('owner');
  const family = resolution?.action.move?.familyKey ?? resolution?.action.templateId ?? routeChoice('family');
  const target = routeChoice('target');
  const route: WorkflowRoute | null = actorId && family ? {
    actorId,
    targetActorIds: resolution ? [...resolution.action.targetActorIds] : target ? [target === 'SELF' ? actorId : target] : [],
    kind: pack?.families.find(item => item.key === family)?.label ?? family.replaceAll('_', ' '),
  } : null;
  const meterChanges: WorkflowMeterChange[] = [];
  for (const [id, meters] of Object.entries(attempt.storyAfter?.meters ?? {})) {
    for (const [key, to] of Object.entries(meters)) {
      const definition = pack?.meters.find(meter => meter.key === key);
      const from = attempt.storyBefore?.meters[id]?.[key] ?? definition?.initial ?? null;
      if (from === to) continue;
      meterChanges.push({ actorId: id, meter: key, label: definition ? meterLabel(definition, PLAYER_LABEL) : key,
        from, to, fromLabel: from === null ? 'Not recorded' : definition?.levels[from] ?? String(from), toLabel: definition?.levels[to] ?? String(to) });
    }
  }
  const reveals: NonNullable<WorkflowBadge['reveals']> = [];
  for (const [secretId, knownBy] of Object.entries(attempt.storyAfter?.knownBy ?? {})) {
    const secret = record?.story.secrets.find(item => item.id === secretId);
    const previous = attempt.storyBefore?.knownBy[secretId] ?? secret?.holders ?? [];
    const actorIds = knownBy.filter(id => !previous.includes(id));
    if (actorIds.length) reveals.push({ secretId, text: secret?.text ?? '', actorIds });
  }
  const lore = attempt.loreCursor ? record?.story.lore[attempt.loreCursor] : null;
  return {
    schemaVersion: 1,
    requestUsage: mergeRequestUsage(attempt.requestUsage, ...(record?.inspector.filter(entry => entry.attemptId === attempt.attemptId).map(entry => entry.requestUsage) ?? [])),
    pacing: attempt.frozenPacing ? { ...structuredClone(attempt.frozenPacing),
      handBack: attempt.injectedText.includes('[Director hand-back — preserve on wording swipes]') ? attempt.frozenPacing.handBack : null } : null,
    replyCheck: attempt.replyCheck ? structuredClone(attempt.replyCheck) : undefined,
    replyCheckError: attempt.replyCheckError,
    rerolledByCheck: attempt.rerolledByCheck,
    replyOriginalSwipe: attempt.replyOriginalSwipe,
    attemptId: attempt.attemptId,
    unavailable: (attempt.judgeErrors?.length ?? 0) > 0,
    retryEligible: attempt.judgeFailedStages === undefined
      ? (attempt.judgeErrors?.length ?? 0) > 0 && !resolution && !permit
      : attempt.judgeFailedStages.some(stage => ['move', 'route', 'ruling'].includes(stage)),
    toolError: attempt.toolError ?? null,
    errors,
    results,
    reaction: attempt.reaction ? { actorId: attempt.reaction.actorId, outcome: attempt.reaction.outcome, draw: attempt.reaction.draw } : null,
    createdAt: attempt.createdAt,
    actorNames,
    move: resolution?.action.move?.passage ?? resolution?.action.attemptedAction ?? selectedSentence,
    route,
    writerInstruction: attempt.injectedText,
    speaker: speakerId ? { actorId: speakerId, name: uiActorName(speakerId === YIELD ? 'player' : speakerId, actorNames[speakerId]) } : null,
    meterChanges,
    reveals,
    lore: (lore?.refs ?? []).map(({ world, uid, title }) => ({ world, uid, title })),
  };
}

export function workflowBadgeLabel(badge: WorkflowBadge): string {
  const result = badge.results[0];
  const parts = ['Director'];
  if (badge.rerolledByCheck) parts.push(`rerolled (${badge.rerolledByCheck})`);
  if (badge.pacing?.handBack === 'HAND_BACK') parts.push('your turn at the next beat');
  if (badge.unavailable) parts.push('judge unavailable');
  else if (badge.toolError) parts.push('writer tool request rejected');
  if (result) {
    parts.push(result.outcome.replaceAll('_', ' '));
    if (result.odds !== null) parts.push(`${Math.round(result.odds * 100)}%`);
    if (result.draw !== null) parts.push(`rolled ${Math.round(result.draw * 100)}`);
    if (badge.results.length > 1) parts.push(`+${badge.results.length - 1} ${badge.results.length === 2 ? 'roll' : 'rolls'}`);
  } else if (badge.reaction) parts.push(`${uiActorName(badge.reaction.actorId, badge.actorNames?.[badge.reaction.actorId])} · ${badge.reaction.outcome.replaceAll('_', ' ')}`);
  else if (!badge.unavailable && !badge.toolError && badge.speaker) parts.push(`${badge.speaker.name} takes the lead`);
  else if (!badge.unavailable) parts.push('no move');
  return parts.join(' · ');
}

/** Chat metadata may have been edited or imported; malformed data is ignored. */
export function isWorkflowBadge(value: unknown): value is WorkflowBadge {
  if (!value || typeof value !== 'object') return false;
  const badge = value as WorkflowBadge;
  const strings = (items: unknown): items is string[] => Array.isArray(items) && items.every(item => typeof item === 'string');
  return badge.schemaVersion === 1 && typeof badge.attemptId === 'string' && typeof badge.unavailable === 'boolean'
    && (badge.requestUsage === undefined || Array.isArray(badge.requestUsage) && badge.requestUsage.every(isRequestUsage))
    && (badge.rerolledByCheck === undefined || ['writes for {{user}}', 'broken ruling'].includes(badge.rerolledByCheck))
    && (badge.replyCheckError === undefined || typeof badge.replyCheckError === 'string')
    && (badge.pacing === undefined || badge.pacing === null || (typeof badge.pacing === 'object'
      && (badge.pacing.scene === null || ['combat', 'conversation', 'travel', 'intimate', 'downtime'].includes(badge.pacing.scene))
      && (badge.pacing.handBack === null || ['HAND_BACK', 'CONTINUE'].includes(badge.pacing.handBack))
      && typeof badge.pacing.dynamicResponse === 'boolean' && typeof badge.pacing.instruction === 'string' && typeof badge.pacing.handBackInstruction === 'string'))
    && (badge.replyCheck === undefined || (badge.replyCheck !== null && typeof badge.replyCheck === 'object'
      && [badge.replyCheck.speaksForUser, badge.replyCheck.responds, badge.replyCheck.repeats, badge.replyCheck.followsRuling].every(value => value === null || Number.isFinite(value))
      && (badge.replyCheck.reason === null || ['writes for {{user}}', 'broken ruling'].includes(badge.replyCheck.reason)) && typeof badge.replyCheck.nudge === 'string'))
    && (badge.retryEligible === undefined || typeof badge.retryEligible === 'boolean')
    && (badge.toolError === undefined || badge.toolError === null || typeof badge.toolError === 'string')
    && Array.isArray(badge.errors) && badge.errors.every(error => typeof error === 'string')
    && Array.isArray(badge.results) && badge.results.every(result => result && ['move', 'npc'].includes(result.source)
      && typeof result.actorId === 'string' && typeof result.action === 'string' && typeof result.outcome === 'string'
      && typeof result.instruction === 'string' && (result.odds === null || (Number.isFinite(result.odds) && result.odds >= 0 && result.odds <= 1))
      && (result.draw === null || (Number.isFinite(result.draw) && result.draw >= 0 && result.draw < 1)))
    && (badge.reaction === null || (Boolean(badge.reaction) && typeof badge.reaction.actorId === 'string'
      && typeof badge.reaction.outcome === 'string' && Number.isFinite(badge.reaction.draw)))
    && (badge.createdAt === undefined || Number.isFinite(badge.createdAt))
    && (badge.actorNames === undefined || (badge.actorNames !== null && typeof badge.actorNames === 'object' && !Array.isArray(badge.actorNames)
      && Object.values(badge.actorNames).every(name => typeof name === 'string')))
    && (badge.move === undefined || badge.move === null || typeof badge.move === 'string')
    && (badge.writerInstruction === undefined || typeof badge.writerInstruction === 'string')
    && (badge.route === undefined || badge.route === null || (typeof badge.route.actorId === 'string' && strings(badge.route.targetActorIds) && typeof badge.route.kind === 'string'))
    && (badge.speaker === undefined || badge.speaker === null || (typeof badge.speaker.actorId === 'string' && typeof badge.speaker.name === 'string'))
    && (badge.meterChanges === undefined || (Array.isArray(badge.meterChanges) && badge.meterChanges.every(change => change && typeof change.actorId === 'string'
      && typeof change.meter === 'string' && typeof change.label === 'string' && (change.from === null || Number.isInteger(change.from)) && Number.isInteger(change.to)
      && typeof change.fromLabel === 'string' && typeof change.toLabel === 'string')))
    && (badge.reveals === undefined || (Array.isArray(badge.reveals) && badge.reveals.every(reveal => reveal && typeof reveal.secretId === 'string'
      && typeof reveal.text === 'string' && strings(reveal.actorIds))))
    && (badge.lore === undefined || (Array.isArray(badge.lore) && badge.lore.every(pick => pick && typeof pick.world === 'string' && Number.isInteger(pick.uid) && typeof pick.title === 'string')));
}
