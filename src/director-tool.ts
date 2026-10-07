/**
 * Plan-only writer checkpoint for newly invented consequential NPC actions.
 *
 * The writer may describe a proposal, but this module owns validation and the
 * one assessment batch. A proposal is never canonical state. The returned
 * permit is attempt-scoped and is the only authority the recursive writer gets.
 */
import type {
  ActionSpec, AttemptFamily, DecisionProvider, DecisionSnapshot, DirectorProfile, EvaluationResult,
  FailureStake, FailureStakeKind, Json, PlannedAction, Question, TurnPermit, TurnProposal,
} from './types.ts';
import { newId, randomDraw } from './identity.ts';
import { normaliseSignal, resolveOutcome } from './resolver.ts';
import { fillPlaceholders } from './prompts.ts';
import { visibleText } from './pipeline/spans.ts';
import { StagedError, validateStageAnswers } from './pipeline/staged.ts';

export const DIRECTOR_TOOL_NAME = 'RPDirector_AdjudicateTurn';
export const MAX_PLANNED_ACTIONS = 3;

/** Operational tool prompt, separate from outcome-table prose and dynamic identities. */
export const DIRECTOR_TOOL_DESCRIPTION = [
  'Adjudicate newly planned uncertain, consequential NPC actions before narrating their results.',
  'WHEN: your selected character plans an action that can fail and changes the scene: forcing a door, evading an attack, concealing an item, detecting a clue, persuading someone to perform a bounded act, or taking possession.',
  'SKIP: ordinary dialogue, reactions, trivial or established actions, and the player attempt already resolved by the Director pre-pass.',
  'Use the frozen actor IDs and evidence references in the Director context. Supply a concrete method, one objective result and bounded failure stakes per action; at most three independent actions in one call.',
  'You may use the model\'s normal reasoning before calling, but never put reasoning, a thinking trace, drafted prose, invented rolls or predicted outcomes in the arguments. Do not narrate a result before the tool returns.',
  'The tool may show its results for review before returning. Its returned permit is authoritative for this attempt. Then write the final reply, obeying the permit; no further Director call, no extra consequential action, and no Director permits, IDs, JSON or other Director metadata. A preset-required fictional tracker block is fine.',
  'Feelings, attraction, consent, trust and permanent attitudes are not mechanical rewards. Leave the player\'s voluntary response open.',
].join('\n');

const FAMILIES: readonly AttemptFamily[] = [
  'overcome_operate', 'contest_impose', 'evade_resist', 'conceal_deceive',
  'detect_discover', 'influence_negotiate', 'acquire_secure',
];
const STAKES: readonly FailureStakeKind[] = [
  'delay', 'exposure', 'injury', 'lost_position', 'resource_cost',
  'relationship_friction', 'closed_opportunity', 'other',
];
const PSYCHOLOGICAL_RESULT = /\b(feel(?:s|ing)?|love|loves|attract(?:ed|ion)?|affection|consent(?:s|ed)?|trust(?:s|ed)?|loyal(?:ty)?|permanent(?:ly)?\s+(?:likes?|hates?|attitude)|fall(?:s|ing)?\s+in\s+love)\b/i;

export interface ToolValidationContext {
  requestId: string;
  attemptId: string;
  speakerActorId: string;
  knownActorIds: string[];
  allowedEvidenceRefs: string[];
}

export type ToolProposalErrorCode =
  | 'malformed'
  | 'unknown_field'
  | 'wrong_request'
  | 'wrong_attempt'
  | 'speaker_mismatch'
  | 'too_many_actions'
  | 'no_actions'
  | 'unknown_actor'
  | 'duplicate_target'
  | 'duplicate_proposal'
  | 'unknown_evidence'
  | 'unbounded_result'
  | 'forbidden_result'
  | 'invalid_action';

export type ToolProposalValidation =
  | { ok: true; proposal: TurnProposal }
  | { ok: false; code: ToolProposalErrorCode; message: string };

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): string | null {
  const set = new Set(allowed);
  return Object.keys(value).find(key => !set.has(key)) ?? null;
}

function boundedText(value: unknown, label: string, max: number): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== 'string') return { ok: false, message: `${label} must be a string` };
  const text = visibleText(value).replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, message: `${label} must not be empty` };
  if (text.length > max) return { ok: false, message: `${label} exceeds ${max} characters` };
  return { ok: true, value: text };
}

/** Strictly validates untrusted function-call arguments. */
export function validateTurnProposal(raw: unknown, ctx: ToolValidationContext): ToolProposalValidation {
  const root = object(raw);
  if (!root || root.schemaVersion !== 1 || !Array.isArray(root.actions)) {
    return { ok: false, code: 'malformed', message: 'Expected schemaVersion 1 and an actions array.' };
  }
  const rootUnknown = exactKeys(root, ['schemaVersion', 'requestId', 'attemptId', 'speakerActorId', 'actions']);
  if (rootUnknown) return { ok: false, code: 'unknown_field', message: `Unknown proposal field ${rootUnknown}. Draft prose is not accepted.` };
  if (root.requestId !== ctx.requestId) return { ok: false, code: 'wrong_request', message: 'The tool request does not match the active writer request.' };
  if (root.attemptId !== ctx.attemptId) return { ok: false, code: 'wrong_attempt', message: 'The proposal does not match the active generation attempt.' };
  if (root.speakerActorId !== ctx.speakerActorId) return { ok: false, code: 'speaker_mismatch', message: 'The writer may not change the frozen reply speaker.' };
  if (root.actions.length === 0) return { ok: false, code: 'no_actions', message: 'Do not call the tool when no new consequential NPC action is planned.' };
  if (root.actions.length > MAX_PLANNED_ACTIONS) return { ok: false, code: 'too_many_actions', message: `At most ${MAX_PLANNED_ACTIONS} planned NPC actions may be adjudicated in one turn.` };

  const actorIds = new Set(ctx.knownActorIds);
  const evidence = new Set(ctx.allowedEvidenceRefs);
  const proposalIds = new Set<string>();
  const actions: PlannedAction[] = [];
  for (let index = 0; index < root.actions.length; index++) {
    const item = object(root.actions[index]);
    if (!item) return { ok: false, code: 'invalid_action', message: `Action ${index + 1} must be an object.` };
    const unknown = exactKeys(item, ['proposalId', 'actingActorId', 'targetActorIds', 'family', 'method', 'boundedResult', 'failureStake', 'opposed', 'evidenceRefs']);
    if (unknown) return { ok: false, code: 'unknown_field', message: `Unknown action field ${unknown}. Full draft text is not accepted.` };
    const proposalId = boundedText(item.proposalId, `actions[${index}].proposalId`, 80);
    const method = boundedText(item.method, `actions[${index}].method`, 280);
    const result = boundedText(item.boundedResult, `actions[${index}].boundedResult`, 240);
    if (!proposalId.ok || !method.ok || !result.ok) {
      return { ok: false, code: 'invalid_action', message: (!proposalId.ok ? proposalId.message : !method.ok ? method.message : (result as { ok: false; message: string }).message) };
    }
    if (proposalIds.has(proposalId.value)) return { ok: false, code: 'duplicate_proposal', message: `Duplicate proposalId ${proposalId.value}.` };
    proposalIds.add(proposalId.value);
    if (typeof item.actingActorId !== 'string' || !actorIds.has(item.actingActorId)) return { ok: false, code: 'unknown_actor', message: `Action ${proposalId.value} has an unknown acting actor.` };
    if (item.actingActorId !== ctx.speakerActorId) return { ok: false, code: 'speaker_mismatch', message: 'Newly planned actions must be performed by the frozen reply speaker.' };
    if (!Array.isArray(item.targetActorIds) || item.targetActorIds.some(id => typeof id !== 'string' || !actorIds.has(id))) {
      return { ok: false, code: 'unknown_actor', message: `Action ${proposalId.value} contains an unknown target actor.` };
    }
    const targets = [...item.targetActorIds].sort();
    if (new Set(targets).size !== targets.length) return { ok: false, code: 'duplicate_target', message: `Action ${proposalId.value} repeats a target actor.` };
    if (typeof item.family !== 'string' || !FAMILIES.includes(item.family as AttemptFamily)) return { ok: false, code: 'invalid_action', message: `Action ${proposalId.value} has an unknown family.` };
    if (typeof item.opposed !== 'boolean') return { ok: false, code: 'invalid_action', message: `Action ${proposalId.value} must declare whether it is opposed.` };
    if (!Array.isArray(item.evidenceRefs) || item.evidenceRefs.length > 8 || item.evidenceRefs.some(ref => typeof ref !== 'string' || !evidence.has(ref))) {
      return { ok: false, code: 'unknown_evidence', message: `Action ${proposalId.value} references evidence outside the frozen snapshot.` };
    }
    if (new Set(item.evidenceRefs).size !== item.evidenceRefs.length) return { ok: false, code: 'unknown_evidence', message: `Action ${proposalId.value} repeats an evidence reference.` };
    const stake = object(item.failureStake);
    if (!stake || exactKeys(stake, ['kind', 'detail'])) return { ok: false, code: 'invalid_action', message: `Action ${proposalId.value} has an invalid failureStake.` };
    if (typeof stake.kind !== 'string' || !STAKES.includes(stake.kind as FailureStakeKind)) return { ok: false, code: 'invalid_action', message: `Action ${proposalId.value} has an unknown failure stake.` };
    const detail = boundedText(stake.detail, `actions[${index}].failureStake.detail`, 240);
    if (!detail.ok) return { ok: false, code: 'invalid_action', message: detail.message };
    if (PSYCHOLOGICAL_RESULT.test(result.value)) return { ok: false, code: 'forbidden_result', message: `Action ${proposalId.value} tries to author feelings, consent, trust, or permanent attitude.` };
    if (/\n|;|\band\s+then\b/i.test(String(item.boundedResult))) return { ok: false, code: 'unbounded_result', message: `Action ${proposalId.value} must name one bounded state change.` };
    actions.push({
      proposalId: proposalId.value,
      actingActorId: item.actingActorId,
      targetActorIds: targets,
      family: item.family as AttemptFamily,
      method: method.value,
      boundedResult: result.value,
      failureStake: { kind: stake.kind as FailureStakeKind, detail: detail.value },
      opposed: item.opposed,
      evidenceRefs: [...item.evidenceRefs] as string[],
    });
  }

  return {
    ok: true,
    proposal: {
      schemaVersion: 1,
      requestId: ctx.requestId,
      attemptId: ctx.attemptId,
      speakerActorId: ctx.speakerActorId,
      actions,
    },
  };
}

export const TURN_PROPOSAL_SCHEMA: Json = {
  $schema: 'http://json-schema.org/draft-04/schema#',
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', enum: [1] },
    requestId: { type: 'string' },
    attemptId: { type: 'string' },
    speakerActorId: { type: 'string' },
    actions: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          proposalId: { type: 'string', description: 'Short unique id for this proposed action.' },
          actingActorId: { type: 'string' },
          targetActorIds: { type: 'array', items: { type: 'string' } },
          family: { type: 'string', enum: [...FAMILIES] },
          method: { type: 'string', description: 'Concrete method, not draft prose.' },
          boundedResult: { type: 'string', description: 'One objective immediate state change; never feelings, consent, trust, or permanent attitude.' },
          failureStake: {
            type: 'object', additionalProperties: false,
            properties: { kind: { type: 'string', enum: [...STAKES] }, detail: { type: 'string' } },
            required: ['kind', 'detail'],
          },
          opposed: { type: 'boolean' },
          evidenceRefs: { type: 'array', items: { type: 'string' } },
        },
        required: ['proposalId', 'actingActorId', 'targetActorIds', 'family', 'method', 'boundedResult', 'failureStake', 'opposed', 'evidenceRefs'],
      },
    },
  },
  required: ['schemaVersion', 'requestId', 'attemptId', 'speakerActorId', 'actions'],
};

function plannedQuestion(action: PlannedAction, path: string, score: boolean): Question {
  const common = `Assess only ${path}. Use its method, boundedResult, failureStake, opposed flag, and evidenceRefs against the frozen pre-action scene. The proposal is not evidence of success. Never manufacture feelings, attraction, consent, trust, love, or permanent attitude change.`;
  if (score) {
    return {
      type: 'score', instructions: common,
      criteria: [
        'Established evidence strongly opposes the bounded result.',
        'Support is weak; an important capability, cue, condition, or leverage is missing.',
        'Mixed or incomplete support; only limited progress is justified.',
        'Strong concrete support for the bounded result now.',
        'Established facts make the bounded result clearly justified now.',
      ],
    };
  }
  return {
    type: 'noul', instructions: `${common} Does ${action.actingActorId} achieve the one bounded result now through the stated method?`,
    criteria: { true: 'Established evidence supports the bounded result now.', false: 'Established evidence does not support the bounded result now.' },
  };
}

export interface AdjudicateProposalInput {
  proposal: TurnProposal;
  provider: DecisionProvider;
  profile: DirectorProfile;
  snapshot: DecisionSnapshot;
  actorNames: Record<string, string>;
  playerName: string;
  signal: AbortSignal;
  now?: number;
}

export interface AdjudicateProposalResult {
  permit: TurnPermit;
  evaluation: EvaluationResult;
  snapshot: DecisionSnapshot;
  questions: Record<string, Question>;
}

/** The NPC tool is public-only, including when reassessing a saved 0.7 permit. */
function publicToolEvidence(value: Json, names: Record<string, string>): Record<string, Json> {
  const base = object(value) ?? {};
  const actors: Record<string, Json> = Object.fromEntries(Object.entries(names).map(([id, name]) => [id, { name: visibleText(name) }]));
  for (const [id, raw] of Object.entries(object(base.actors) ?? {})) {
    const actor = object(raw);
    if (!actor) continue;
    actors[id] = {
      ...(object(actors[id]) as Record<string, Json> ?? {}),
      ...(typeof actor.name === 'string' ? { name: visibleText(actor.name) } : {}),
      ...(actor.control === 'user' || actor.control === 'npc' ? { control: actor.control } : {}),
    };
  }
  const recentAcceptedMessages: Json[] = [];
  for (const raw of Array.isArray(base.recentAcceptedMessages) ? base.recentAcceptedMessages : []) {
    const message = object(raw);
    if (!message || !['user', 'assistant'].includes(String(message.role)) || typeof message.text !== 'string') continue;
    recentAcceptedMessages.push({
      role: String(message.role), text: visibleText(message.text),
      ...(typeof message.actorId === 'string' ? { actorId: message.actorId } : {}),
      ...(typeof message.speaker === 'string' ? { speaker: visibleText(message.speaker) } : {}),
    });
  }
  return {
    actors, recentAcceptedMessages,
    latestInput: typeof base.latestInput === 'string' ? visibleText(base.latestInput) : '',
    ...(typeof base.playerActorId === 'string' ? { playerActorId: base.playerActorId } : {}),
  };
}

/** Executes exactly one provider batch and freezes every returned action meaning. */
export async function adjudicateTurnProposal(input: AdjudicateProposalInput): Promise<AdjudicateProposalResult> {
  // Keep the boundary safe even for a saved proposal used by Reassess.
  const safeProposal: TurnProposal = {
    schemaVersion: 1, requestId: input.proposal.requestId, attemptId: input.proposal.attemptId, speakerActorId: input.proposal.speakerActorId,
    actions: input.proposal.actions.map(action => ({
      proposalId: visibleText(action.proposalId), actingActorId: action.actingActorId, targetActorIds: [...action.targetActorIds], family: action.family,
      method: visibleText(action.method), boundedResult: visibleText(action.boundedResult), opposed: action.opposed, evidenceRefs: [...action.evidenceRefs],
      failureStake: { kind: action.failureStake.kind, detail: visibleText(action.failureStake.detail) },
    })),
  };
  if (safeProposal.actions.some(action => !action.method || !action.boundedResult || !action.failureStake.detail)) throw new StagedError('ruling', 'A planned action has no visible method, result or failure stake.');
  const plannedActions: Record<string, Json> = {};
  const questions: Record<string, Question> = {};
  for (const [index, action] of safeProposal.actions.entries()) {
    plannedActions[action.proposalId] = action as unknown as Json;
    questions[`planned_${index + 1}`] = plannedQuestion(action, `state.plannedActions.${action.proposalId}`, input.profile.drivingQuestionId === 'gain_score');
  }
  if (Object.keys(questions).length > Math.min(16, input.profile.budgets.maxQuestions)) throw new StagedError('ruling', 'Planned action batch exceeds the question budget.');
  const base = publicToolEvidence(input.snapshot.state, input.actorNames);
  const publicSnapshot: DecisionSnapshot = { ...input.snapshot, state: base };
  const snapshot: DecisionSnapshot = { ...publicSnapshot, state: { ...base, plannedActions } };
  const contextCharacters = JSON.stringify(snapshot.state).length;
  if (contextCharacters > input.profile.budgets.maxSerializedCharacters) {
    throw new StagedError('ruling', `Planned action context exceeds the limit (${contextCharacters}/${input.profile.budgets.maxSerializedCharacters} characters). No decision was requested.`, 'context_budget');
  }
  const checked = validateStageAnswers('ruling', questions, await input.provider.evaluate({ requestId: newId('req'), phase: 'guide', snapshot, questions }, input.signal));
  if (checked.errors.length) throw new StagedError('ruling', checked.errors.map(error => error.message).join('; '), checked.errors[0]!.type);
  const evaluation = checked.result;
  const actions = [];
  for (const [index, proposal] of safeProposal.actions.entries()) {
    const questionId = `planned_${index + 1}`;
    const answer = evaluation.answers[questionId];
    if (!answer) throw new Error(`No valid assessment for ${proposal.proposalId}: ${evaluation.errors[questionId] ?? 'missing'}`);
    const signal = normaliseSignal(answer);
    if (!signal.ok) throw new Error(`Invalid assessment for ${proposal.proposalId}: ${signal.error}`);
    const draw = input.profile.resolutionMethod === 'sample' ? randomDraw().u : null;
    const resolved = resolveOutcome({ bands: input.profile.bands, outcomes: input.profile.outcomes, method: input.profile.resolutionMethod, signal: signal.signal, draw });
    if (!resolved.ok) throw new Error(`Could not resolve ${proposal.proposalId}: ${resolved.error}`);
    const target = proposal.targetActorIds.map(id => input.actorNames[id] ?? id).join(' and ') || 'the immediate obstacle';
    const instruction = fillPlaceholders(resolved.value.def.instruction, {
      gain: proposal.boundedResult,
      action: proposal.method,
      target,
      player: input.playerName,
      speaker: input.actorNames[input.proposal.speakerActorId] ?? input.proposal.speakerActorId,
    }).trim();
    actions.push({
      proposalId: proposal.proposalId,
      resolutionId: newId('res'),
      actingActorId: proposal.actingActorId,
      targetActorIds: proposal.targetActorIds,
      family: proposal.family,
      method: proposal.method,
      boundedResult: proposal.boundedResult,
      failureStake: proposal.failureStake,
      opposed: proposal.opposed,
      outcome: resolved.value.outcome,
      instruction,
      recordedValue: resolved.value.def.records,
      finalForScope: resolved.value.def.final,
      scope: 'attempt' as const,
      assessment: structuredClone(answer),
      draw: resolved.value.draw,
      methodUsed: input.profile.resolutionMethod,
      policyBand: structuredClone(resolved.value.band),
      outcomeDefinition: structuredClone(resolved.value.def),
    });
  }
  const permit: TurnPermit = {
    schemaVersion: 1,
    permitId: newId('permit'),
    attemptId: input.proposal.attemptId,
    speakerActorId: input.proposal.speakerActorId,
    baseCursor: input.snapshot.cursorBefore,
    stateRevision: input.snapshot.stateRevision,
    actions,
    compactState: {
      sceneId: 0,
      revision: input.snapshot.stateRevision,
    },
    constraints: [
      'Write the final reply directly; do not call RPDirector_AdjudicateTurn again.',
      'Apply only these attempt-scoped rulings. Do not invent another unresolved consequential action.',
      'Do not output Director data or metadata such as permits, rulings, request IDs, actor IDs, evidence references, or JSON. This does not prohibit a preset-required fictional tracker block.',
      `Do not author ${input.playerName}'s voluntary actions, speech, thoughts, feelings, consent, or decisions.`,
    ],
    createdAt: input.now ?? Date.now(),
    proposal: structuredClone(safeProposal),
    snapshot: structuredClone(publicSnapshot),
    profile: structuredClone(input.profile),
  };
  return { permit, evaluation, snapshot, questions };
}

export function toolPlanningBlock(input: {
  attemptId: string;
  requestId: string;
  speakerActorId: string;
  evidenceRefs: string[];
  toolAvailable: boolean;
}): string {
  if (!input.toolAvailable) {
    return '[Director NPC-action boundary]\nFunction tools are unavailable on this writer backend. Write the final prose directly. You may react, apply established capabilities, or set up pressure, but leave any newly invented uncertain consequential NPC action unresolved.';
  }
  return [
    '[Director NPC-action checkpoint]',
    'Write the final prose directly unless you newly plan an uncertain consequential NPC action whose result would change fictional state.',
    `Before any prose for such an action, call ${DIRECTOR_TOOL_NAME} once with schemaVersion 1, requestId ${input.requestId}, attemptId ${input.attemptId}, and speakerActorId ${input.speakerActorId}.`,
    `Allowed evidenceRefs: ${JSON.stringify(input.evidenceRefs)}.`,
    `Submit at most ${MAX_PLANNED_ACTIONS} actions. Give only actor IDs, targets, family, concrete method, one bounded objective result, bounded failure stake, opposition, and evidence refs. Never include draft prose.`,
    'If no newly invented uncertain consequential NPC action is needed, do not call the tool. Do not roll dice before a permit is returned.',
    'Normal model reasoning may precede the tool call. Send only the bounded proposal, never your thinking trace or draft. If review is enabled, the user keeps or rerolls the results before the tool returns; otherwise the results apply automatically.',
  ].join('\n');
}

export function permitFollowupBlock(permit: TurnPermit | null, failure: string | null = null): string {
  if (!permit) {
    return `[Director tool result]\nThe proposal was not permitted${failure ? `: ${failure}` : '.'} Write the final reply without resolving any newly invented uncertain consequential NPC action. Do not call the tool again.`;
  }
  return [
    '[Director turn permit — binding for this reply]',
    JSON.stringify(writerPermit(permit)),
    'Now write the final reply. Obey every permitted outcome and constraint. Do not call the tool again, add another consequential action, or emit Director permits, IDs, JSON, or other Director metadata.',
  ].join('\n');
}

/** Full snapshot/table/history stay local; the writer receives only the final rulings. */
export function writerPermit(permit: TurnPermit) {
  const { proposal: _proposal, snapshot: _snapshot, profile: _profile, reviewHistory: _history, replayTrimmed: _trimmed, ...result } = permit;
  return result;
}

/** Converts a permitted action to the existing action shape for audit/UI helpers. */
export function permittedActionSpec(action: PlannedAction, actionId: string, sceneId: number): ActionSpec {
  return {
    actionId,
    identityVersion: 2,
    templateId: action.family,
    actingActorId: action.actingActorId,
    playerActorId: action.actingActorId,
    targetActorIds: action.targetActorIds,
    attemptedAction: action.method,
    requestedGain: action.boundedResult,
    applicability: 'favorable',
    uncertainConsequential: true,
    opposed: action.opposed,
    resolutionScope: 'attempt',
    sceneId,
    persistentFactKey: '',
    failureStake: action.failureStake,
    availableEvidence: action.evidenceRefs.join(', '),
    preconditions: [],
  };
}
