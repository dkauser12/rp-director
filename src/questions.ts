/**
 * Question templates and independent batching (plan §3, §10).
 *
 * Questions in one batch share one public state and never depend on each
 * other's answers. The state sent is a focused snapshot, never the writer
 * prompt. Budgets are enforced before any network call.
 */
import type { ActionSpec, ActorBinding, Json, Question } from './types.ts';
import { YIELD } from './types.ts';
import { actionFamily } from './templates.ts';

export interface RecentMessage {
  actorId: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface SnapshotStateInput {
  scopeId: string;
  actors: Record<string, ActorBinding>;
  eligibleActorIds: string[];
  /** Public card summaries by actor id; never private notes. */
  publicCards: Record<string, string>;
  facts: Record<string, Json>;
  action: ActionSpec | null;
  latestInput: string;
  recentMessages: RecentMessage[];
  sceneId: number;
  acceptedReplyCount: number;
  maxRecentMessages: number;
  maxSerializedCharacters: number;
}

export interface BuiltState {
  state: Json;
  /** What was left out, for the inspector. */
  exclusions: string[];
  serializedCharacters: number;
  overBudget: boolean;
}

/** Builds the shared-scope state object. Oldest recent messages are dropped first; the newest input and action facts are never truncated. */
export function buildState(input: SnapshotStateInput): BuiltState {
  const exclusions: string[] = [];
  const detection = input.action && actionFamily(input.action.templateId) === 'detect_discover';
  let recent = input.recentMessages.slice(-input.maxRecentMessages);
  if (recent.length < input.recentMessages.length) exclusions.push(`${input.recentMessages.length - recent.length} older messages beyond maxRecentMessages`);

  const actors: Record<string, Json> = {};
  for (const [id, binding] of Object.entries(input.actors)) {
    const entry: Record<string, Json> = { control: binding.control, name: binding.name };
    const card = input.publicCards[id];
    // Raw card descriptions are authorial characterization, not proof that an
    // observer knows a secret. Omit them entirely for detection judgments.
    if (card && !detection) entry.authorialCharacterContext = card;
    actors[id] = entry;
  }

  const build = (messages: RecentMessage[]): Json => ({
    scopeId: input.scopeId,
    eligibleActorIds: [...input.eligibleActorIds],
    actors,
    facts: structuredClone(input.facts) as Json,
    action: input.action ? {
      actionId: input.action.actionId,
      family: actionFamily(input.action.templateId),
      actingActorId: input.action.actingActorId ?? input.action.playerActorId,
      targetActorIds: [...input.action.targetActorIds],
      attemptedAction: input.action.attemptedAction,
      requestedGain: input.action.requestedGain,
      applicability: input.action.applicability,
      uncertainConsequential: input.action.uncertainConsequential !== false,
      opposed: input.action.opposed === true,
      resolutionScope: input.action.resolutionScope ?? 'persistent',
      failureStake: input.action.failureStake ? { kind: input.action.failureStake.kind, detail: input.action.failureStake.detail } : null,
      availableEvidence: input.action.availableEvidence ?? '',
      additionalAttemptsPolicy: input.action.additionalAttemptsPolicy ?? null,
      preconditions: input.action.preconditions.map(p => ({ factId: p.factId, expected: p.expected, actual: p.actual, known: p.known })),
    } : null,
    latestInput: input.latestInput,
    scene: { id: input.sceneId, acceptedReplyCount: input.acceptedReplyCount },
    recentAcceptedMessages: messages.map(m => ({ actorId: m.actorId, role: m.role, text: m.text })),
  });

  let state = build(recent);
  if (detection) exclusions.push('authorial card descriptions omitted: detection may use only observer-visible cues supplied with the attempt');
  let size = JSON.stringify(state).length;
  while (size > input.maxSerializedCharacters && recent.length > 0) {
    recent = recent.slice(1);
    exclusions.push('dropped oldest recent message to fit maxSerializedCharacters');
    state = build(recent);
    size = JSON.stringify(state).length;
  }
  return { state, exclusions, serializedCharacters: size, overBudget: size > input.maxSerializedCharacters };
}

export function speakerQuestion(eligible: string[], names: Record<string, string>, includeYield: boolean, latestAddressHint: string | null): Question {
  const criteria: Record<string, string | null> = {};
  for (const id of eligible) criteria[id] = `${names[id] ?? id}: eligible to speak next.`;
  if (includeYield) criteria[YIELD] = 'No eligible NPC needs to speak; return control to the player.';
  const hint = latestAddressHint ? ` The latest input is: "${latestAddressHint}".` : '';
  return {
    type: 'choice',
    instructions: `Using only state.eligibleActorIds, state.actors, and the latest accepted exchange in state, which eligible NPC should speak next? Favor a direct unanswered address or a concrete reason to respond; choose YIELD when the player should act. Do not select the player. Character IDs are the supplied option keys.${hint}`,
    criteria,
  };
}

export function gainNoulQuestion(): Question {
  return {
    type: 'noul',
    instructions: 'Do the established pre-action facts in state justify granting state.action.requestedGain now, given state.action.attemptedAction? Evaluate that proposition only; the attempt is not evidence of success.',
    criteria: {
      true: 'Concrete supplied evidence supports the specified favorable gain now.',
      false: 'The supplied evidence does not support that favorable gain now.',
    },
  };
}

export type AutoAttemptGate = 'none' | 'trivial_or_certain' | 'one_consequential' | 'multiple_consequential';

/** Classifies whether the latest user message needs mechanical adjudication. */
export function autoAttemptGateQuestion(): Question {
  return {
    type: 'choice',
    instructions: 'Using state.latestInput and the accepted scene only, how many uncertain, consequential state-changing attempts does the player make? A check is warranted only when failure is possible and would materially change what happens. Speech, feelings, wants, decisions, trivial activity, and already-established outcomes are not checks.',
    criteria: {
      none: 'No attempted state change; ordinary dialogue, observation, OOC, or reaction only.',
      trivial_or_certain: 'An action occurs, but established facts make it routine/certain or failure has no meaningful consequence.',
      one_consequential: 'Exactly one primary uncertain and consequential attempt needs a ruling.',
      multiple_consequential: 'Two or more separate uncertain and consequential attempts are bundled together.',
    },
  };
}

/** Family is guidance for the writer and inspector; it never creates another roll. */
export function autoAttemptFamilyQuestion(): Question {
  return {
    type: 'choice',
    instructions: 'Classify the first primary uncertain, consequential attempt in state.latestInput. If there is no such attempt, choose none. Choose the closest functional family; do not classify feelings, desires, consent, or relationship meaning as an attempt.',
    criteria: {
      none: 'No uncertain consequential attempt.',
      overcome_operate: 'Overcome an obstacle or operate, repair, treat, craft, break, or create something.',
      contest_impose: 'Actively overcome opposition: attack, grapple, restrain, seize, interrupt, force, or outmaneuver.',
      evade_resist: 'Escape, dodge, withstand, retain control, or avoid an imposed consequence.',
      conceal_deceive: 'Lie, hide, sneak, steal unnoticed, disguise, misdirect, or maintain an alibi.',
      detect_discover: 'Notice, search, investigate, recognize a tell, catch a lie, or establish a hidden fact from visible cues.',
      influence_negotiate: 'Seek one specific immediate conduct through a request, bargain, argument, threat, or pressure.',
      acquire_secure: 'Secure bounded access, information, possession, permission, or commitment.',
    },
  };
}

/** One atomic success proposition that remains valid when the independent family answer is ignored. */
export function autoAttemptNoulQuestion(): Question {
  return {
    type: 'noul',
    instructions: 'If state.latestInput contains an uncertain consequential attempt, do the established pre-action facts support the FIRST primary intended state change succeeding now? Judge the concrete method against capabilities, opposition, leverage, tools, injuries, positioning, and observer-visible evidence. The attempt itself is not evidence of success. For detection, private card truth or hidden thoughts are not observer knowledge. Judge immediate conduct only; never manufacture feelings, attraction, affection, consent, trust, or permanent attitude change. If there is no qualifying attempt, answer false; code will ignore this answer.',
    criteria: {
      true: 'Established pre-action evidence supports the first primary bounded result now.',
      false: 'Established evidence does not support that bounded result now, or no qualifying attempt exists.',
    },
  };
}

/** One decisive proposition per declared attempt. Family wording narrows what evidence is relevant without creating dependent questions. */
export function attemptNoulQuestion(action: ActionSpec): Question {
  const common = 'Use established pre-action facts only. The attempted action is not evidence that it succeeded. Respect the bounded result and the declared failure stakes.';
  switch (actionFamily(action.templateId)) {
    case 'overcome_operate':
      return { type: 'noul', instructions: `Can state.action.actingActorId produce state.action.requestedGain now by the method in state.action.attemptedAction, given the established competence, tools, conditions, and obstacles? ${common}`, criteria: { true: 'The concrete method and established conditions support producing the bounded result now.', false: 'The concrete method or established conditions do not support producing the bounded result now.' } };
    case 'contest_impose':
      return { type: 'noul', instructions: `Does state.action.actingActorId overcome the declared opposition and achieve state.action.requestedGain in this one exchange? Judge the acting method against the active opposition; do not resolve the same contest twice. ${common}`, criteria: { true: 'The acting side overcomes the declared opposition in this exchange.', false: 'The declared opposition prevents the bounded result in this exchange.' } };
    case 'evade_resist':
      return { type: 'noul', instructions: `Does state.action.actingActorId evade or resist the specified imposed consequence and achieve state.action.requestedGain in this exchange? ${common}`, criteria: { true: 'The actor avoids or withstands the specified consequence.', false: 'The specified consequence is not avoided or withstood.' } };
    case 'conceal_deceive':
      return { type: 'noul', instructions: `Does state.action.actingActorId keep state.action.requestedGain concealed from the declared target observers using state.action.attemptedAction? Judge only what those observers could perceive or verify. ${common}`, criteria: { true: 'The concealment or deception holds against the declared observers now.', false: 'The declared observers detect or defeat the concealment now.' } };
    case 'detect_discover':
      return { type: 'noul', instructions: `Do the observer-visible cues in state.action.availableEvidence, together with the observer's established capabilities, justify state.action.actingActorId discovering state.action.requestedGain now? Do not use authorial card truth, private thoughts, hidden narration, or mere existence of the fact as observer knowledge. ${common}`, criteria: { true: 'The explicitly supplied observable cues support this bounded discovery now.', false: 'The supplied observable cues do not support this bounded discovery now.' } };
    case 'influence_negotiate':
      return { type: 'noul', instructions: `Given the target's established interests, boundaries, leverage, and current circumstances, does the target choose the specific conduct in state.action.requestedGain now in response to state.action.attemptedAction? Judge immediate conduct only; do not manufacture affection, attraction, consent, trust, or a permanent change of attitude. ${common}`, criteria: { true: 'The target chooses the specified bounded conduct now.', false: 'The target does not choose the specified bounded conduct now.' } };
    case 'acquire_secure':
    default:
      return { type: 'noul', instructions: `Does state.action.actingActorId secure state.action.requestedGain now through state.action.attemptedAction, given the established access, ownership, opposition, and conditions? ${common}`, criteria: { true: 'The bounded access, information, possession, or commitment is secured now.', false: 'The bounded result is not secured now.' } };
  }
}

export function gainScoreQuestion(): Question {
  return {
    type: 'score',
    instructions: 'Using only state.action.requestedGain, state.action.attemptedAction, and the established facts in state, rate how well supported the requested favorable gain is NOW. Assess the evidence rather than pleasing the player. Do not assume the attempted action has already succeeded.',
    criteria: [
      'Established evidence strongly opposes this gain.',
      'Evidence is weak; important justification is missing.',
      'Mixed or incomplete support; only limited progress is justified.',
      'Strong concrete support for this bounded gain.',
      'The supplied evidence makes the bounded gain clearly justified.',
    ],
  };
}

export function attemptScoreQuestion(action: ActionSpec): Question {
  const family = actionFamily(action.templateId).replace('_', ' / ');
  return {
    type: 'score',
    instructions: `For this ${family} attempt, rate how strongly the established pre-action facts support state.action.actingActorId achieving state.action.requestedGain now through state.action.attemptedAction. The attempt is not evidence of success. For detection, use only state.action.availableEvidence as observer knowledge. Do not manufacture feelings, consent, trust, or permanent attitude changes.`,
    criteria: [
      'Established evidence strongly opposes the bounded result.',
      'Support is weak; an important capability, cue, condition, or leverage is missing.',
      'Mixed or incomplete support; only limited progress is justified.',
      'Strong concrete support for the bounded result now.',
      'Established facts make the bounded result clearly justified now.',
    ],
  };
}

export interface BatchCheck {
  ok: boolean;
  errors: string[];
}

/**
 * Rejects batches that would need answer-dependent inputs or mixed private
 * scopes. Every question must be fully specified from the shared state; a
 * question whose instructions reference another question's answer is refused.
 */
export function checkBatch(questions: Record<string, Question>, maxQuestions: number, scopeIds: string[]): BatchCheck {
  const errors: string[] = [];
  const ids = Object.keys(questions);
  if (ids.length > maxQuestions) errors.push(`${ids.length} questions exceed the budget of ${maxQuestions}`);
  const distinctScopes = new Set(scopeIds.filter(Boolean));
  if (distinctScopes.size > 1) errors.push(`questions span ${distinctScopes.size} private scopes; one batch may use one scope`);
  for (const [id, q] of Object.entries(questions)) {
    if (!q.instructions || q.instructions.trim().length < 20) errors.push(`${id}: instructions must be complete`);
    for (const other of ids) {
      if (other !== id && new RegExp(`answers?\\.${other}\\b|\\{\\{${other}\\}\\}`, 'i').test(q.instructions)) {
        errors.push(`${id}: depends on the answer to ${other}; dependent questions cannot share a batch`);
      }
    }
    if (q.type === 'choice' && Object.keys(q.criteria).length === 0) errors.push(`${id}: choice has no options`);
    if (q.type === 'score' && q.criteria.length < 2) errors.push(`${id}: score needs at least two levels`);
  }
  return { ok: errors.length === 0, errors };
}
